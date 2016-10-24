// ## MqttReqRes

/*
A connect(B)


  - when connreq && connack === connreq
    - resolve

  - else when !connreq || connack !== connreq
    - set connreq = randomString
    - set connack = null
    - set channelNonce = randomString()
    - send connreq,channelNonce to B.handleConnectRequest()
    - wait for connackResolve
    - resolve / reject on timeout


B handleConnectRequest (connreqA, channelNonceA)

  - when !connreqA
    - ignore, done

  - else when !connreq || connreqA !== connack
    - set connreq = connreqA
    - set connack = connreqA
    - set channelNonce = randomString()
    - set channelSendId = hash(connack, channelNonce, channelNonceA, sharedSecretAB)
    - set channelReceiveId = hash(connack, channelNonceA, channelNonce, sharedSecretAB)
    - subscribe topic to receive from A
    - send connack,channelNonce to A.handleConnectAck()
    - done

  - else when connreqA === connack
      - send connack,channelNonce to A.handleConnectAck()
      - done

  - else    
    - ignore, done


A handleConnectAck (connackB, channelNonceB)
  
  when connreq && connreq === connackB
    - set connack = connreq
    - set channelSendId = hash(connack, channelNonce, channelNonceB, sharedSecretAB)
    - set channelReceiveId = hash(connack, channelNonceB, channelNonce, sharedSecretAB)
    - subscribe topic to receive from B
    - connackResolve()

  - else
    - ignore

B connect(A): vice versa

*/

// ### export module
module.exports = function () {

  'use strict';

  // ### dependencies
  var mqtt = require('mqtt');
  var EventEmitter = require('events');
  var CryptoJS = require('./crypto-js/cryptojs-module.js');
  var debug = require('debug')('mqtt-reqres');
  var noop = function () {};

  var MAX_CHUNK_SIZE = 1024 * 64;

  /*
    ### class MqttReqRes
    #### constructor(options)
    options:
    - brokerProtocol string optional default 'mqtt' ('ws')
    - brokerHostname string optional default 'localhost'
    - brokerPort number optional default 1883
    - clientId string optional default random string
  */
  function MqttReqRes (options) {

    // call super constructor.
    EventEmitter.call(this);

    this.options = options = options || {};

    this.initialize(options);
  }


  // MqttReqRes extends EventEmitter
  MqttReqRes.prototype = Object.create(EventEmitter.prototype);
  MqttReqRes.prototype.constructor = MqttReqRes;  


  // ### MqttReqRes.randomString(length) 
  MqttReqRes.randomString = function (length) {
      
    var validChars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
      validCharsLength = validChars.length,
      str = '',
      remaining;

    remaining = length = length || 25;

    while (remaining--) {
      str += validChars[Math.floor(Math.random() * validCharsLength)];
    }

    return str;
  };


  // ### MqttReqRes.hash()
  MqttReqRes.hash = function () {

    // use sha512

    var shasum = CryptoJS.algo.SHA512.create(),
      args = Array.prototype.slice.call(arguments,0),
      hash;

    args.forEach(function (v) {
      shasum.update(String(v));
    });

    hash = shasum.finalize();

    return hash.toString(CryptoJS.enc.Base64)
      .replace(/\W/g,'');
  };


  // ### MqttReqRes.encrypt(message, secret) 
  MqttReqRes.encrypt = function (message, secret) {
    var encrypted = CryptoJS.AES.encrypt(String(message), secret);
    return CryptoJS.AESJsonFormatter.stringify(encrypted);
  };


  // ### MqttReqRes.decrypt(encrypted, secret)
  MqttReqRes.decrypt = function (encrypted, secret) {
    var decrypted = encrypted ? 
      CryptoJS.AES.decrypt(encrypted, secret, {format: CryptoJS.AESJsonFormatter}) : '';
    return encrypted && decrypted ? decrypted.toString(CryptoJS.enc.Utf8) : '';
  };


  // ### MqttReqRes.secret(connection)
  MqttReqRes.secret = function (connection) {
    return MqttReqRes.hash(
        connection.sharedSecret,
        connection.connreq
      );
  };


  // ### MqttReqRes.isConnected(connection)
  MqttReqRes.isConnected = function (connection) {
    return !!(
      connection && 
      connection.clientId &&
      connection.sharedSecret &&
      connection.connreq && 
      connection.connreq === connection.connack && 
      connection.channelNonce && 
      connection.channelSendId && 
      connection.topicSend && 
      connection.channelReceiveId && 
      connection.topicReceive
    );
  };


  // ### MqttReqRes.initialize(options)
  MqttReqRes.prototype.initialize = function (options) {

    debug('initialize()', options);

    // remove all internal listeners
    this.removeAllListeners('_broker-connect');
    this.removeAllListeners('_response');
    this.removeAllListeners('_client-connack');
    this.removeAllListeners('_stream-request-chunk');
    this.removeAllListeners('_stream-on-request-chunk');
    this.removeAllListeners('_stream-response-chunk');

    this.mqttClient = null;

    this.brokerProtocol = options.brokerProtocol || 'mqtt';
    this.brokerHostname = options.brokerHostname || 'localhost';
    this.brokerPort = options.brokerPort || 1883;

    // The Server MUST allow ClientIds which are between 1 and 23 UTF-8 encoded bytes in 
    // length, and that contain only the characters 0-9a-Z
    this.clientId = options.clientId || MqttReqRes.randomString(23);

    this.subscribedConnect = false;
    this.isWaitingForMqttClientMessages = false;

    // use ```client.sharedSecret(function (clientId, cb){cb('my-secret');})``` to set function 
    this.fnGetSharedSecret = null;
    
    this.fnOnRequest = null;

    // list of connections to other clients
    this.connections = [];
  };


  // ### MqttReqRes.getConnection(clientId, forceGet)
  MqttReqRes.prototype.getConnection = function (clientId, forceGet) {

    var connection = this.connections.find(function (connection) {
      return !!(connection && connection.clientId === clientId);
    });

    if (!connection && forceGet && clientId) {
      
      connection = {
        
        // connected client id e.g., 'WTwke7a4Yn5KobZbckgrRAj',
        clientId: clientId,

        // sharedSecret string
        sharedSecret: null,

        // connreq null|string the connection request id set and sent by the client that initiated the connection
        connreq: null,

        // connack boolean|string the connection ack id 
        connack: null,

        // channel nonce: nonce for calculating channel ids 
        channelNonce: null,

        // publish -t message/&lt;this-client-id&gt;/&lt;channel-send-id&gt;/
        topicSend: null,

        // subscribe -t message/&lt;connected-client-id&gt;/&lt;channel-receive-id&gt;/#
        topicReceive: null,

        // &lt;channel-receive-id&gt;: the channel id of the channel this client listenes for messages sent by the other client. 
        channelReceiveId: null,

        // &lt;channel-send-id&gt;: the channel id of the channel this client sends messages to the other client. 
        channelSendId: null

        // channel-receive-id 
      };

      this.connections.push(connection);
    }

    return connection;
  };


  // ### MqttReqRes.getConnected()
  MqttReqRes.prototype.getConnected = function () {
    return this.connections.filter(function (connection) {
      return MqttReqRes.isConnected(connection);
    });
  };


  // ### request(string toClientid, string|object|ArrayBuffer payload)
  // override request 
  MqttReqRes.prototype.request = function (toClientId, payload) {

    debug('%s request(%s)', this.clientId, toClientId);

    var self = this,
      type,
      offset = 0,
      payloadLength,
      chunkno = 0,
      remainingLength,
      streamId = MqttReqRes.randomString(),
      eos = false;
    
    if (payload instanceof ArrayBuffer) {
      // ArrayBuffer
      type = 'ArrayBuffer';
    }
    else if (payload instanceof Object) {
      type = 'JSON';
    }
    else {
      type = 'string';
    }
    
    debug('%s request() type: %s', this.clientId, type);    

    if (type === 'JSON') {
      // payload as a JSON string
      payload = JSON.stringify(payload);
    }
    else if (type === 'string'){
      // payload as a string
      payload = String(payload);      
    }

    remainingLength = payloadLength = (type === 'ArrayBuffer' ? 
          payload.byteLength : payload.length);


    function chunkRequest () {

      debug(
        '%s chunkRequest() chunkno %d remainingLength %d', 
        self.clientId, chunkno, remainingLength
      );

      return new Promise (function (resolve, reject) {

        var chunkSize,
          chunkStr,
          chunkUint8Array,
          messageChunkStr;

        chunkSize = remainingLength >= MAX_CHUNK_SIZE ?
          MAX_CHUNK_SIZE : remainingLength;

        eos = chunkSize === remainingLength;

        if (chunkSize) {
          if (type === 'ArrayBuffer') {
            // chunk as Uint8Array
            // new Uint8Array(buffer [, byteOffset [, length]]);
            chunkUint8Array = new Uint8Array(payload, offset, chunkSize);

            chunkStr = chunkUint8Array.join(',');
          }
          else {
            chunkStr = payload.substr(offset, chunkSize);
          }
        }

        messageChunkStr = JSON.stringify({
            streamId: streamId,
            data: chunkStr,
            type: type,
            chunkno: chunkno,
            eos: eos
          });

        self.requestChunk(toClientId, messageChunkStr)
          .then(function (response) {

            debug('%s chunkRequest () responded', self.clientId);
            
            offset += chunkSize;

            remainingLength = payloadLength - offset;

            self.emit(
              '_stream-request-chunk', 
              {streamId: streamId, response: response, eos: eos}
            );

            resolve();
          })
          .catch(reject); 
      });
    }

    function waitForChunksDone () {

      debug(
        '%s waitForChunksDone() streamId %s payloadLength %d', 
        self.clientId, streamId, payloadLength
      );

      return new Promise (function (resolve, reject) {

        function onStreamChunk (ev) {
          if (ev.streamId === streamId) {

            if (ev.eos) {
              self.removeListener('_stream-request-chunk', onStreamChunk);
              resolve(ev.response);
            }
            else {
              // start next chunk request
              ++chunkno;
              chunkRequest().catch(reject);
            }
          }
        }
        
        self.on('_stream-request-chunk', onStreamChunk);

        // start first chunk request
        chunkRequest().catch(reject);
      });
    }

    return waitForChunksDone();
    // return MqttReqRes.prototype.request.apply(this, arguments); 
  };


  // ### MqttReqRes.requestChunk(toClientId, messageChunkStr) 
  MqttReqRes.prototype.requestChunk = function (toClientId, messageChunkStr) {

    debug('%s request(%s)', this.clientId, toClientId);

    var self = this,
      connection,
      req,
      requestId,
      secret;

    function sendRequest () {

      debug('%s sendRequest() to %s', self.clientId, toClientId);

      return new Promise (function (resolve, reject) {

        try {

          connection = self.getConnection(toClientId);

          if (!connection) {
            reject('ECLIENTCONNECTION');
            return;
          }
          
          // generate a chunk request id
          requestId = MqttReqRes.randomString(30);

          secret = MqttReqRes.secret(connection);

          // build request object
          req = {
            requestId: requestId,
            payload: MqttReqRes.encrypt(messageChunkStr, secret) 
          };

          // pubish request
          self.mqttClient.publish(        
            connection.topicSend, 
            JSON.stringify(req), 
            {qos: 0}, 
            function (err) {
              if (err) {
                debug(err);
                reject(err);
              }
              else {
                resolve();
              }
            }
          );
        }
        catch (e) {
          debug(e);
          reject(e);
        }
      });
    }


    return this.connect(toClientId)
      .then(sendRequest)
      .then(function () {
        return self.requestPromiseResponse(requestId, secret);
      });
  };


  // ### MqttReqRes.requestPromiseResponse(requestId, secret)
  MqttReqRes.prototype.requestPromiseResponse = function (requestId, secret) {

    debug('%s requestPromiseResponse()', this.clientId);

    var self =  this;
    
    return new Promise (function (resolve, reject) {

      var result = {
        payload: null,
        type: null
      };


      function handleResponse (responseMessage) {

        var chunk;
        
        if (responseMessage.respondsTo === requestId) {
          
          try {

            chunk = JSON.parse(MqttReqRes.decrypt(responseMessage.payload, secret));
            if (!result.type) {

              result.type = chunk.type;

              debug(
                '%s requestPromiseResponse.handleResponse() chunk type is %s', 
                self.clientId, result.type
              );              
            }

            if (result.type === 'ArrayBuffer') {
             
              if (result.payload === null) {
                result.payload = [];
              }

              chunk.data.split(',').forEach(function (byteStr) {
                result.payload.push(byteStr);
              });
            } 
            else {
              // assume type string or JSON
              if (result.payload === null) {
                result.payload = '';
              }
              result.payload += chunk.data;
            }

            if (chunk.eos) {
              
              self.removeListener('_response', handleResponse);

              if (result.type === 'ArrayBuffer') {
                result.payload = Uint8Array.from(result.payload).buffer;
              }
              else if (result.type === 'Object') {
                result.payload = JSON.parse(result.payload);
              }

              resolve(result);
              self.emit('response', result);
            }
          }
          catch(e) {
            reject(e);
          }
        }
      }

      self.on('_response', handleResponse);
    });
  };


  /* 
    #### connect([toClientId, sharedSecret])

    - toClientId string optional default undefined. the id of the client to connect to
    - sharedSecret string optional, required when toClientId is set
  */
  MqttReqRes.prototype.connect = function (toClientId, sharedSecret) {

    debug('%s connect(%s)', this.clientId, toClientId);
    
    var self = this,
      connection = this.getConnection(toClientId);

    if (MqttReqRes.isConnected(connection)) {
      return Promise.resolve();
    }

    // connect to broker
    return this.connectToBroker()
      .then(function () {
        // subscribe to connect topic
        return self.subscribeConnect();
      })
      .then(function () {

        self.emit('broker-connect');          

        if (toClientId) {
          // connect to other client when toClientId is set
          return self.connectToClient(toClientId, sharedSecret);
        }
        else {
          return Promise.resolve();
        }
      });
  };


  /*
    #### connectToBroker()
    connect to broker
  */
  MqttReqRes.prototype.connectToBroker = function () {

    debug('%s connectToBroker()', this.clientId);
    // console.log('%s connectToBroker()', this.clientId);

    var self = this;

    return new Promise (function (resolve, reject) {

      var connectSuccess = false;

      // already connected to broker?
      if (self.mqttClient && self.mqttClient.connected) {
        resolve();
        return;
      }

      // reset subsciption to connect flag
      self.subscribedConnect = false;
      self.isWaitingForMqttClientMessages = false;

      // connect to broker
      self.mqttClient = mqtt.connect({ 
          protocol: self.brokerProtocol,
          host: self.brokerHostname, 
          port: self.brokerPort,
          clientId: self.clientId
        });
      
      self.mqttClient.on('connect', function () {
        self.emit(
          '_broker-connect', 
          // connack packet
          Array.prototype.slice.call(arguments)[0]
        );
      }); 

      self.once('_broker-connect', function () {
        connectSuccess = true;
        resolve();
      });

      setTimeout(function () {
        if (!connectSuccess) {
          reject(new Error('EMQTTCLIENTCONNECTTIMEOUT'));
        }
      }, 3000);
    });
  };


  /*
    #### subscribeConnect()
    subscribe to topic connect/&lt;client-id&gt;/#
  */
  MqttReqRes.prototype.subscribeConnect = function () {

    debug('%s subscribeConnect()', this.clientId);

    var self = this,
      topic = 'connect/' + this.clientId + '/+';

    return new Promise (function (resolve, reject) {

      // check for broker connection
      if (!self.mqttClient || !self.mqttClient.connected) {
        reject(new Error('EMQTTCLIENTCONNECTION'));
        return;
      }

      // check if already subscribed to topic connect 
      if (self.subscribedConnect) {
        resolve();
        return;
      }

      // subscribe to connect topic
      self.mqttClient.subscribe(
        topic, 
        {qos: 0}, 
        function (err, granted) {
          if (err) {
            reject(err);
          }
          else {
            if (granted[0].qos === 0) {
              self.subscribedConnect = true;
              try {
                self.waitForMqttClientMessages();
                resolve();                           
              }
              catch (e) {
                reject(e);
              }
            }
            else {
              reject(new Error('ESUBSCRIBECONNECT'));
            }
          }
        }
      );
    });
  };
  

  /*
    ### connectToClient (toClientId[, sharedSecret])
    - toClientId string required. the id of the client to connect to
    - sharedSecret string optional. if set, sharedSecret will be set to connection    
  */
  MqttReqRes.prototype.connectToClient = function (toClientId, sharedSecret) {

    // A connect(B)

    debug('%s connectToClient(%s)', this.clientId, toClientId);

    var self = this,
      connection = this.getConnection(toClientId, true);

    // - when connreq && connack === connreq
    if (MqttReqRes.isConnected(connection)) {
      return Promise.resolve();
    }

    if (sharedSecret) {
      connection.sharedSecret = sharedSecret;
    }

    // - else when !connreq || connack !== connreq

    //   - set connreq = randomString
    connection.connreq = MqttReqRes.randomString(30);

    //   - set connack = null
    connection.connack = null;

    //   - set channelNonce = randomString()
    connection.channelNonce = MqttReqRes.randomString(30);

    connection.channelReceiveId = null;
    connection.topicReceive = null;
    connection.channelSendId = null;
    connection.topicSend = null;

    function awaitConnack () {

      //   - wait for connackResolve
      return new Promise (function (resolve, reject) {


        var resolved = false;

        // handleConnectAck (ev{connack,channelNonce})
        function handleClientConnack (ev) {

          //   when connreq && connreq === connackB
          if (
              ev &&
              ev.clientId === toClientId && 
              ev.connack === connection.connreq &&
              ev.channelNonce
            ) {           

            self.removeListener('_client-connack', handleClientConnack);

            debug('%s client-connect in connectToClient()', self.clientId, toClientId);   

            //     - set connack = connreq
            connection.connack = connection.connreq;

            //     - set channelSendId = hash(connack, channelNonce, channelNonceB, sharedSecretAB)
            connection.channelSendId = MqttReqRes.hash(
                connection.connack,
                connection.channelNonce,
                ev.channelNonce,
                connection.sharedSecret
              );

            // - set channelReceiveId = hash(connack, channelNonceB, channelNonce, sharedSecretAB)
            connection.channelReceiveId = MqttReqRes.hash(
                connection.connack,
                ev.channelNonce,
                connection.channelNonce,
                connection.sharedSecret
              );

            connection.topicReceive = null;
            connection.topicSend = null;

            resolved = true;

            resolve(toClientId);
          }
          //   - else
          //     - ignore
        }

        self.on('_client-connack', handleClientConnack);
        
        // reject on timeout
        setTimeout(function () {
          if (!resolved) {
            reject(new Error('ECLIENTCONNACKTIMEOUT'));
          }
        }, 10000);
      });
    }

    // A  - send connreq,channelNonce to B.handleConnectRequest()
    return this.publishConnectRequest(toClientId)
      .then(function () {
        return self.getSharedSecret(connection);
      })
        //   - wait for connackResolve
      .then(awaitConnack)
      .then(function () {
         //     - subscribe topic to receive from B
        return self.subscribeReceiveChannel(toClientId);
      })
      .then(function () {    
        if (MqttReqRes.isConnected(connection)) {
          self.emit('client-connect', toClientId);
          return Promise.resolve(toClientId);
        }
        else {
          debug('failed to connect to client', connection);
          return Promise.reject(new Error('ECLIENTCONNECT'));
        }
      });
  };


  /*
    #### waitForMqttClientMessages()
    
  */
  MqttReqRes.prototype.waitForMqttClientMessages = function () {

    debug('%s waitForMqttClientMessages()', this.clientId);

    var self = this;

    if (this.isWaitingForMqttClientMessages) {
      return;
    }

    // check for broker connection
    if (!this.mqttClient || !this.mqttClient.connected) {
      throw new Error('EMQTTCLIENTCONNECTION');
    }

    if (!this.subscribedConnect) {
      throw new Error('ESUBSCRIBEDCONNECT');
    }

    this.isWaitingForMqttClientMessages = true;

    /*
    handle incoming messages
    */
    this.mqttClient.on('message', function (topic, message) {
      try {
        self.handleMqttClientMessage(topic, message);
      }
      catch(e) {
        debug(e);
      }
    });

    return this;
  };


  // ### MqttReqRes.handleMqttClientMessage(topic, mqttMessage) 
  MqttReqRes.prototype.handleMqttClientMessage = function (topic, mqttMessage) {

    debug('%s handleMqttClientMessage(%s)', this.clientId, topic);

    var topicPath = topic.split('/'),
      message;

    if (!this.isWaitingForMqttClientMessages) {
      return;
    }

    if (!mqttMessage) {
      return;
    }

    try {
      
      message = JSON.parse(mqttMessage);

      if ('object' !== typeof message) {
        // ignore message
        return;
      }

      if (topicPath[0] === 'connect') {
          
        // is connect topic publish -t connect/to-device-id/from-device-id -m connack|connreq
        
        if (message.connreq) {
          this.handleConnectRequest(topicPath, message);
        }
        else if (message.connack) {
          this.handleConnectAck(topicPath, message);
        }
        // else: ignore
      }
      else if (topicPath[0] === 'message'){

        // is message topic publish -t message/<from-device-id>/<to-channel-id>
        
        if (message.requestId) {
          this.handleMessageRequest(topicPath, message);
        }
        else if (message.respondsTo) {
          this.handleMessageResponse(topicPath, message);
        }
        // else: ignore
      }

    }
    catch (e) {
      // ignore json parse error
      debug(e);
    }

    return this;
  };


  /*
    #### handleConnectRequest

    -t connect/to-device-id/from-device-id -m channel-receive-id
  */
  MqttReqRes.prototype.handleConnectRequest = function (topicPath, reqMessage) {

    // B handleConnectRequest (reqMessage{connreqA, channelNonceA})

    debug('%s handleConnectRequest(%s)', this.clientId, topicPath.join('/'));

    var self = this,
      clientId,
      connection;

    // validate topic

    // check if connecting to this client
    if (topicPath[1] !== this.clientId) {
      // not to this client
      return;
    }

    //   - when !connreq
    if (!reqMessage.connreq) {
      //     - ignore, done
      return;
    }

    if (!reqMessage.channelNonce) {
      // no channel id for sending channel is set
      return;
    }

    clientId = topicPath[2];

    if (!clientId) {
      // invalid connect request
      return;
    }

    // get connection 
    connection = this.getConnection(clientId, true);

    // - else when !connreq || connreqA !== connack
    if (!connection.connreq || reqMessage.connreq !== connection.connack) {

      self.getSharedSecret(connection)
        .then(function () {

          // - set connreq = connreqA
          connection.connreq = reqMessage.connreq;

          // - set connack = connreqA
          connection.connack = reqMessage.connreq;

          // - set channelNonce = randomString()
          connection.channelNonce = MqttReqRes.randomString(30);

          // - set channelSendId = hash(connack, channelNonce, channelNonceA, sharedSecretAB)
          connection.channelSendId = MqttReqRes.hash(
              connection.connack,
              connection.channelNonce,
              reqMessage.channelNonce,
              connection.sharedSecret
            );

          // - set channelReceiveId = hash(connack, channelNonceA, channelNonce, sharedSecretAB)
          connection.channelReceiveId = MqttReqRes.hash(
              connection.connack,
              reqMessage.channelNonce,
              connection.channelNonce,
              connection.sharedSecret
            );

          connection.topicReceive = null;
          connection.topicSend = null;

          // - subscribe topic to receive from A
          self.subscribeReceiveChannel(clientId)      
            .then(function () {
              // - send connack,channelNonce to A.handleConnectAck()
              return self.publishConnectAck(clientId);
            })
            .then(function () {
              if (MqttReqRes.isConnected(connection)) {
                self.emit('client-connect', clientId);
              }
              else {
                debug('failed to connect to client', connection);
              }
            });
            // - done
        });
    }
    // - else when connreqA === connack
    else if (connection.connack === reqMessage.connreq) {
      // connection already established
      // - send connack,channelNonce to A.handleConnectAck()
      self.publishConnectAck(clientId);
      // - done
    }
    //   - else  ignore, done

    return this;
  };


  // ### MqttReqRes.sharedSecret(fnGetSharedSecret)
  MqttReqRes.prototype.sharedSecret = function (fnGetSharedSecret) {

    this.fnGetSharedSecret = 'function' === typeof fnGetSharedSecret ?
      fnGetSharedSecret : null;

    return this;
  };


  // ### MqttReqRes.getSharedSecret(connection) 
  MqttReqRes.prototype.getSharedSecret = function (connection) {

    debug('%s getSharedSecret(%s)', this.clientId, connection && connection.clientId);

    var self = this;

    return new Promise (function (resolve, reject) {
      if (!connection) {
        reject(new Error('ECLIENTCONNECTION'));
      }
      else if (connection.sharedSecret) {
        resolve(connection.sharedSecret);
      }
      else if ('function' === typeof self.fnGetSharedSecret) {
        self.fnGetSharedSecret(connection.clientId, function (sharedSecret) {
          connection.sharedSecret = sharedSecret;
          resolve(sharedSecret);
        });
      }
      else {
        resolve();
      }
    });
  };


  // ### MqttReqRes.publishConnectAck(clientId) 
  MqttReqRes.prototype.publishConnectAck = function (clientId) {

    debug('%s publishConnectAck(%s)', this.clientId, clientId);

    var self = this;

    return new Promise (function (resolve, reject) {
      
      // get connection 
      var connection = self.getConnection(clientId),
        topic,
        message;

      topic = 'connect/' + clientId + '/' + self.clientId;

      message = JSON.stringify({
        connack: connection.connack,
        channelNonce: connection.channelNonce
      });

      self.mqttClient.publish(
        topic,
        message, 
        {qos: 0, retain: false}, 
        function (err) {
          if (err) {
            reject(err);
          }
          else {
            resolve(clientId);            
          }
        }
      );
    });      
  };


  // ### MqttReqRes.handleConnectAck(topicPath, ackMessage) 
  MqttReqRes.prototype.handleConnectAck = function (topicPath, ackMessage) {

    // A handleConnectAck (ackMessage{connackB, channelNonceB})

    debug('%s handleConnectAck(%s)', this.clientId, topicPath.join('/'));
    
    var clientId;

    // validate topic

    // check if connecting to this client
    if (topicPath[1] !== this.clientId) {
      // not to this client
      return;
    }

    clientId = topicPath[2];

    if (!clientId) {
      // invalid connect request
      return;
    }

    this.emit('_client-connack', {
      clientId: clientId,
      connack: ackMessage.connack,
      channelNonce: ackMessage.channelNonce,
    });

    return this;
  };


  // ### MqttReqRes.handleMessageRequest(topicPath, requestMessage) 
  MqttReqRes.prototype.handleMessageRequest = function (topicPath, requestMessage) {
    
    debug('%s handleMessageRequest(%s)', this.clientId, topicPath.join('/'));

    var self = this,
      req,
      res,
      clientId,
      connection,
      secret;

    if ('function' !== typeof this.fnOnRequest) {
      // no request handler defined, ignore message request
      return this;
    }

    clientId = topicPath[1];

    connection = this.getConnection(clientId);

    if (!MqttReqRes.isConnected(connection)) {
      // unknown connection, do not respond
      return this;
    }

    secret = MqttReqRes.secret(connection);

    req = {
      topic: topicPath.join('/'),
      payload: MqttReqRes.decrypt(requestMessage.payload, secret),
      connection: connection
    };

    res = {
      respondsTo: requestMessage.requestId,
      send: function (payload) {
        return self.sendResponse(connection, requestMessage.requestId, payload, secret);
      }
    };

    // call request handler
    this.fnOnRequest(req, res);

    return this;
  };



  // ### sendResponse(object connection, string respondToRequestId, string|object|ArrayBuffer payload, string secret)
  MqttReqRes.prototype.sendResponse = function (connection, respondToRequestId, payload, secret) {

    debug('%s sendResponse() respondToRequestId %s', this.clientId, respondToRequestId);

    // ArrayBuffer
    var self = this,
      type,
      offset = 0,
      payloadLength,
      chunkno = 0,
      remainingLength,
      streamId = MqttReqRes.randomString(),
      eos = false;


    if (payload instanceof ArrayBuffer) {
      // ArrayBuffer
      type = 'ArrayBuffer';
    }
    else if (payload instanceof Object) {
      type = 'JSON';
    }
    else {
      type = 'string';
    }
    
    debug('%s sendResponse() type: %s', this.clientId, type);    

    if (type === 'JSON') {
      // payload as a JSON string
      payload = JSON.stringify(payload);
    }
    else if (type === 'string'){
      // payload as a string
      payload = String(payload);      
    }

    remainingLength = payloadLength = (type === 'ArrayBuffer' ? 
          payload.byteLength : payload.length);

    function chunkResponse () {

      debug(
        '%s chunkResponse() chunkno %d remainingLength %d', 
        self.clientId, chunkno, remainingLength
      );

      return new Promise (function (resolve, reject) {

        var chunkSize,
          chunkStr,
          chunkUint8Array,
          message;

        chunkSize = remainingLength >= MAX_CHUNK_SIZE ?
          MAX_CHUNK_SIZE : remainingLength;

        eos = chunkSize === remainingLength;

        if (chunkSize) {
          if (type === 'ArrayBuffer') {
            // chunk as Uint8Array
            // new Uint8Array(buffer [, byteOffset [, length]]);
            chunkUint8Array = new Uint8Array(payload, offset, chunkSize);

            chunkStr = chunkUint8Array.join(',');
          }
          else {
            chunkStr = payload.substr(offset, chunkSize);
          }
        }

        message = JSON.stringify({
          respondsTo: respondToRequestId,
          streamId: streamId,
          data: chunkStr,
          type: type,
          chunkno: chunkno,
          eos: eos
        });

        self.sendResponseChunk(
          connection,
          respondToRequestId,
          message,
          secret
        )
        .then(function () {

            debug('%s chunkResponse () resolved', self.clientId);
            
            offset += chunkSize;

            remainingLength = payloadLength - offset;

            self.emit(
              '_stream-response-chunk', 
              {streamId: streamId, eos: eos}
            );
          }, reject); 
      });
    } // chunkResponse


    function waitForResponseChunksDone () {

      debug(
        '%s waitForResponseChunksDone() streamId %s payloadLength %d', 
        self.clientId, streamId, payloadLength
      );

      return new Promise (function (resolve, reject) {

        function onResponseChunk (ev) {
          if (ev.streamId === streamId) {

            if (ev.eos) {
              self.removeListener('_stream-response-chunk', onResponseChunk);
              resolve();
            }
            else {
              // start next chunk request
              ++chunkno;
              chunkResponse().catch(reject);            
            }
          }
        }
        
        self.on('_stream-response-chunk', onResponseChunk);

        // start first chunk response
        chunkResponse().catch(reject);
      });
    } // waitForResponseChunksDone

    return waitForResponseChunksDone();
  };


  // ### MqttReqRes.sendResponseChunk(object connection, string respondToRequestId, string payload, string secret)
  MqttReqRes.prototype.sendResponseChunk = function (connection, respondToRequestId, payload, secret) {

    debug('%s sendResponseChunk()', this.clientId);

    var self = this;

    return new Promise (function (resolve, reject) {

      var resMessage = {
        respondsTo: respondToRequestId
      };

      try {
        resMessage.payload = MqttReqRes.encrypt(payload, secret);

        self.mqttClient.publish(        
          connection.topicSend, 
          JSON.stringify(resMessage), 
          {qos: 0}, 
          function (err) {
            if (err) {
              // todo: expose error to this client
              debug(err);
              reject(err);
            }
            else {
              resolve();
            }
          }
        );    
      }
      catch (e) {
        // todo: handle/expose error
        debug(e);
      }
    });
  };



  // ### onRequest(function onRequestHandler)
  MqttReqRes.prototype.onRequest = function (onRequestCallback) {

    debug('%s onRequest()', this.clientId);

    var self = this,
      currentStreams = {};

    function pWaitForEOS (streamId) {

      debug('%s pWaitForEOS(%s)', self.clientId, streamId);

      return new Promise (function (resolve, reject) {

        var result = null,
          type;

        function onStreamOnRequestChunk (req, res, chunk) {

          try {

          debug(
            '%s onStreamOnRequestChunk() chunkno %d data.length %d', 
            self.clientId, chunk.chunkno, chunk.data.length
          );

          if (chunk.streamId === streamId) {

            if (!type) {
              type = chunk.type;

              debug(
                '%s onStreamOnRequestChunk() chunk type is %s', 
                self.clientId, type
              );              
            }

            if (type === 'ArrayBuffer') {
             
              if (result === null) {
                result = [];
              }

              chunk.data.split(',').forEach(function (byteStr) {
                result.push(byteStr);
              });
            } 
            else {
              // assume type string or JSON
              if (result === null) {
                result = '';
              }
              result += chunk.data;
            }

            if (chunk.eos) {
              
              // end of stream

              self.removeListener('_stream-on-request-chunk', onStreamOnRequestChunk);
              delete currentStreams[streamId];

              if (type === 'ArrayBuffer') {
                req.payload = Uint8Array.from(result).buffer;
              }
              else if (type === 'Object') {
                req.payload = JSON.parse(result);
              }
              else {
                req.payload = result;
              }

              req.type = type;

              resolve([req, res]);
            }
            else {
              // respond chunk ack
              res.send({
                streamId: streamId,
                chunkno: chunk.chunkno
              });
            }
          }

          }
          catch (e) {
            debug(e);
            reject(e);     
          }

        } // onStreamOnRequestChunk

        self.on('_stream-on-request-chunk', onStreamOnRequestChunk);
      });
    }


    function onStreamRequest (req, res) {

      debug('%s onStreamRequest()', self.clientId);

      var streamMessage;

      try {
        streamMessage = JSON.parse(req.payload);

        if (!streamMessage ||
          !streamMessage.streamId) {
          return;
        }

        if (!currentStreams[streamMessage.streamId]) {
          // new stream
          currentStreams[streamMessage.streamId] = pWaitForEOS(streamMessage.streamId)
            .then(function (result) {
              onRequestCallback.apply(self, result);
            });
        }

        self.emit('_stream-on-request-chunk', req, res, streamMessage);

      }
      catch (e) {
        return;
      }
    } // onStreamRequest


    this.fnOnRequest = onStreamRequest; 
    
    return this;
  };


  // ### MqttReqRes.handleMessageResponse(Array topicPath, responseMessage) 
  MqttReqRes.prototype.handleMessageResponse = function (topicPath, responseMessage) {

    debug('%s handleMessageResponse(%s)', this.clientId, topicPath.join('/'));

    var clientId,
      connection;

    clientId = topicPath[1];
    connection = this.getConnection(clientId);

    if (!MqttReqRes.isConnected(connection)) {
      // unknown connection, do not respond
      return;
    }

    this.emit('_response', responseMessage);

    return this;
  };


  /*
    #### subscribeReceiveChannel(clientId)
    opens a message channel to enable other client to send messages
  */
  MqttReqRes.prototype.subscribeReceiveChannel = function (clientId) {

    debug('%s subscribeReceiveChannel(%s)', this.clientId, clientId);

    var self = this;

    return new Promise (function (resolve, reject) {

      // get connected client 
      var connection = self.getConnection(clientId),
        topic;

      if (!connection) {
        reject(new Error('ECLIENTCONNECTION'));
        return;
      }
      
      /*
      build topic
      
      subscribe -t message/<from-device-id>/<to-channel-id>/#
      */
      topic = 'message/' + clientId + '/' + connection.channelReceiveId + '/#';

      // subscribe to connect topic -t message/&lt;from-device-id&gt;/&lt;to-channel-id&gt;/#
      self.mqttClient.subscribe(
        topic, 
        {qos: 0}, 
        function (err, granted) {
          if (err) {
            reject(err);
            return;
          }

          if (granted[0].qos === 0) {

            // set topicReceive: subscribe -t 'message/&lt;connected-client-id&gt;/&lt;channel-receive-id&gt;/#'
            connection.topicReceive = topic;

            // set topicSend: publish -t 'message/&lt;this-client-id&gt;/&lt;channel-send-id&gt;/'
            connection.topicSend = 'message/' + self.clientId + '/' + connection.channelSendId + '/';

            resolve(clientId);           
          }
          else {
            reject(new Error('ESUBSCRIBERECEIVE'));
          }
        }
      );
    });
  };


  /*
    #### publishConnectRequest()

    publish a connect message to the other client to let him know this client wants to connect

    publish -t connect/to-device-id/from-device-id -m
  */
  MqttReqRes.prototype.publishConnectRequest = function (clientId) {

    debug('%s publishConnectRequest(%s)', this.clientId, clientId);

    var self = this;

    return new Promise (function (resolve, reject) {
      
      // get connected client 
      var connection = self.getConnection(clientId, true),
        topic,
        message;

      topic = 'connect/' + clientId + '/' + self.clientId;

      message = JSON.stringify({
        connreq: connection.connreq,
        channelNonce: connection.channelNonce
      });

      self.mqttClient.publish(
        topic,
        message, 
        {qos: 0, retain: false}, 
        function (err) {
          if (err) {
            reject(err);
          }
          else {
            resolve(clientId);            
          }
        }
      );
    });
  };


  /*
    #### disconnect a client or from broker if clientId is omitted
  */
  MqttReqRes.prototype.disconnect = function (clientId) {

    var self = this;

    return new Promise(function (resolve, reject) {

      var connection;

      if (!clientId) {
        // disconnect from broker
        self.disconnectBroker()
          .then(resolve)
          .catch(reject);
      }
      else {

        connection = self.getConnection(clientId);

        if (!connection || !MqttReqRes.isConnected(connection)) {
          resolve();
          return;
        }
        
        self.disconnectClient(connection)
          .then(resolve)
          .catch(reject);
      }
    });
  };


  // ### MqttReqRes.disconnectClient(connection) 
  MqttReqRes.prototype.disconnectClient = function (connection) {

    debug('%s disconnectClient(%s)', this.clientId, connection && connection.clientId);

    var self = this;

    return new Promise(function (resolve) {

      if (!connection) {
        resolve();
        return;
      }

      // remove from clients list
      self.connections.splice(self.connections.indexOf(connection), 1);

      if (connection.topicReceive) {
        // unsubscribe receive topic
        self.mqttClient.unsubscribe(
          connection.topicReceive, 
          function () {
            connection.topicReceive = null;
            resolve();
          }
        );
      }
      else {
        resolve();
      }

    });
  };


  // ### MqttReqRes.disconnectBroker()
  MqttReqRes.prototype.disconnectBroker = function () {

    debug('%s disconnectBroker()', this.clientId);

    var self = this;

    return new Promise(function (resolve) {

      if (self.mqttClient) {
        self.mqttClient.end(true, function () {
          self.initialize(self.options);
          resolve();
        });
      }
      else {
        self.initialize(self.options);
        resolve();
      }
      
    });
  };


  // ### MqttReqRes.close(callback) 
  MqttReqRes.prototype.close = function (callback) {

    debug('%s close()', this.clientId);

    callback = callback || noop;

    this.disconnect()
      .then(callback)
      .catch(callback);
  };


  return MqttReqRes;

}();

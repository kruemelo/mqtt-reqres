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


mqtt messages types by topicPath[3]

  message topic publish -t message/<from-device-id>/<to-channel-id>/<mqtt-message-type>

- request: message-id
- response: message-id responds-to
- stream: message-id, stream-id, message-target-property
- stream-end: message-id, stream-id
- request-end: message-id
- response-end: message-id
- chunk: stream-id chunk-id

- chunk-ack: to-id
- stream-end-ack: to-id 
- request-end-ack: to-id
- response-end-ack: to-id

- stream-ack: to-id 
- request-ack: to-id
- response-ack: to-id


message flow:

  A: request
  B: request-ack
      A: stream
      B: stream-ack
        A: chunk 
          B: chunk-ack
        .. A: chunk
      A: stream-end
      B: stream-end-ack
      ..A: stream
      A: request-end
      B: request-end-ack
      B: response
      A: response-ack
        B: stream
        A: stream-ack
          B: chunk
            A: chunk-ack
          .. B: chunk
        B: stream-end
        A: stream-end-ack
        .. B: stream
        B: response-end
        A: response-end-ack

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
  var MAX_HASH_LENGTH = 81;  // 81

  var CLIENT_ID_LENGTH = 23; // 23
  var CHANNEL_ID_LENGTH = 25; // 25
  var CHANNEL_NONCE_LENGTH = 25; // 25
  var MESSAGE_ID_LENGTH = 20; // 20
  var STREAM_ID_LENGTH = 10; // 10
  var CHUNK_ID_LENGTH = 10; // 10

  var messageTypes = [
    'request',        
    'request-ack',        
    'request-end',     
    'request-end-ack',     
    'response',        
    'response-ack',   
    'response-end',    
    'response-end-ack',    
    'stream',          
    'stream-ack',        
    'stream-end',      
    'stream-end-ack',      
    'chunk',         
    'chunk-ack'     
  ];

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

  // expose EventEmitter
  MqttReqRes.EventEmitter = EventEmitter;


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
      .replace(/\W/g,'')
      .substr(0, MAX_HASH_LENGTH);
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

    var self = this;

    // remove all internal listeners
    this.removeAllListeners('_broker-connect');
    this.removeAllListeners('_client-connack');
    this.removeAllListeners('_chunk-sent');

    messageTypes.forEach(function (messageType) {
     self.removeAllListeners('_mqtt-message-' + messageType);
    });
    
    this.mqttClient = null;

    this.brokerProtocol = options.brokerProtocol || 'mqtt';
    this.brokerHostname = options.brokerHostname || 'localhost';
    this.brokerPort = options.brokerPort || 1883;

    // The Server MUST allow ClientIds which are between 1 and 23 UTF-8 encoded bytes in 
    // length, and that contain only the characters 0-9a-Z
    this.clientId = options.clientId || MqttReqRes.randomString(CLIENT_ID_LENGTH);

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


  // ### streamSend (connection, messageId, msgTargetProperty, payload)
  // send a string|object|ArrayBuffer payload within an existing message
  MqttReqRes.prototype.streamSend = function (connection, messageId, msgTargetProperty, payload) {

    // debug(
    //   '%s streamSend(%s, %s, %s)', 
    //   this.clientId, connection.clientId, messageId, msgTargetProperty, payload
    // );

    var self = this,
      type,
      payloadLength,
      streamId = MqttReqRes.randomString(STREAM_ID_LENGTH);
    
    if (payload instanceof ArrayBuffer) {
      // ArrayBuffer
      type = 'ArrayBuffer';
    }
    else if (payload === null) {
      type = 'null';
    }
    else if (payload instanceof Object) {
      type = 'JSON';
    }
    else {
      // string instanceof Object -> false
      type = 'string';
    }
    
    debug('%s streamSend() type: %s', this.clientId, type);    

    if (type === 'JSON') {
      // payload as a JSON string
      payload = JSON.stringify(payload);
    }
    else if (type === 'string'){
      // payload as a string
      payload = String(payload);      
    }
    else if (type === 'null') {
      payload = 'null';
    }

    payloadLength = (type === 'ArrayBuffer' ? 
      payload.byteLength : payload.length);


    // _mqtt-message-stream: message-id, stream-id, message-target-property
    function sendStreamMessage () {

      // debug('%s sendStreamMessage() to %s', self.clientId, connection.clientId);

      try {
        return self.mqttPublish(connection, 'stream', JSON.stringify({
          messageId: messageId,
          streamId: streamId,
          type: type,
          targetProperty: msgTargetProperty
        }))
        .then(function() {
          return self.waitForAck('stream-ack', streamId);
        });
      }
      catch (e) {
        debug(e);
        return Promise.reject(e);
      }
    }


    function sendChunks () {

      var offset = 0,
        chunkno = 0,
        remainingLength = payloadLength,
        chunkSize,
        eos = false;

      return new Promise (function (resolve, reject) {

        /*jshint latedef:false*/
        
        function nextChunk () {

          var chunkStr,
            chunkUint8Array;

          chunkSize = remainingLength >= MAX_CHUNK_SIZE ?
            MAX_CHUNK_SIZE : remainingLength;

          eos = chunkSize === remainingLength;

          // debug('%s sendChunks().nextChunk(): payloadLength %d remainingLength %d chunkno %d chunkSize %d eos %s',
          //   self.clientId, payloadLength,
          //   remainingLength,
          //   chunkno,
          //   chunkSize,
          //   eos
          // );

          if (type === 'ArrayBuffer') {
            // chunk as Uint8Array
            // new Uint8Array(buffer [, byteOffset [, length]]);
            chunkUint8Array = new Uint8Array(payload, offset, chunkSize);

            chunkStr = chunkUint8Array.join(',');
          }
          else {
            chunkStr = payload.substr(offset, chunkSize);
          }

          self.streamSendChunk(connection, streamId, chunkStr)
            .then(function() {
            
              offset += chunkSize;

              remainingLength = payloadLength - offset;

              self.emit('_chunk-sent', streamId);
            })
            .catch(function (reason) {
              self.removeListener('_chunk-sent', onChunkSent);
              reject(reason);
            });
        }


        function onChunkSent (chunkSentStreamId) {
          
          if (chunkSentStreamId !== streamId) {
            // not this stream
            return;
          }

          if (eos) {
            self.removeListener('_chunk-sent', onChunkSent);
            resolve();
          }
          else {
            // start next chunk request
            ++chunkno;
            nextChunk();
          }// jshint ignore:line
        } 


        self.on('_chunk-sent', onChunkSent);

        nextChunk();
      });
    }


    // _mqtt-message-stream-end: message-id, stream-id
    function sendStreamEndMessage () {

      // debug('%s sendStreamEndMessage() to %s', self.clientId, connection.clientId);

      try {
        return self.mqttPublish(connection, 'stream-end', JSON.stringify({
          messageId: messageId,
          streamId: streamId
        }))
        .then(function() {
          return self.waitForAck('stream-end-ack', streamId);
        });
      }
      catch (e) {
        debug(e);
        return Promise.reject(e);
      }
    }


    return this.connect(connection.clientId) 
      .then(sendStreamMessage)
      .then(sendChunks)
      .then(sendStreamEndMessage);
  };


  // ### streamSendChunk (connection, streamId, messageChunkStr) 
  // send a chunk message string
  // return Promise.resolve when connected, sent and acked
  MqttReqRes.prototype.streamSendChunk = function (connection, streamId, messageChunkStr) {

    var self = this,
      req,
      // generate a chunk id
      chunkId = MqttReqRes.randomString(CHUNK_ID_LENGTH);

    // debug('%s streamSendChunk() to %s messageChunkStr "%s", connection:', 
    //   this.clientId, connection.clientId,
    //   messageChunkStr,
    //   connection
    // );

    // -mqtt-message-chunk: stream-id chunk-id payload
    function publishChunk () {

      // debug('%s publishChunk() to %s', self.clientId, connection.clientId);

      try {

        // build message object
        req = {
          streamId: streamId,
          // chunk id
          chunkId: chunkId,
          payload: MqttReqRes.encrypt(messageChunkStr, connection.sharedSecret) 
        };

        return self.mqttPublish(connection, 'chunk', JSON.stringify(req));
      }
      catch (e) {
        debug(e);
        return Promise.reject(e);
      }
    }

    return this.connect(connection.clientId)
      .then(publishChunk)
      .then(function () {
        return self.waitForAck('chunk-ack', chunkId);
      });
  };


  MqttReqRes.prototype.sendAck = function (connection, ackMessageName, toId) {

    // debug(
    //   '%s sendAck(%s, %s, toId %s)', this.clientId,
    //   connection.clientId, ackMessageName, toId
    // );

    try {
      return this.mqttPublish(connection, ackMessageName, JSON.stringify({
        toId: toId
      }));
    }
    catch (e) {
      return Promise.reject(e);
    }
  };  // sendAck


  // ### waitForAck (ackMessageName, toId, [timeout=5000])
  // generic wait for ack message
  // - chunk-ack: to-id
  // - stream-ack: to-id 
  // - stream-end-ack: to-id 
  // - request-ack: to-id
  // - request-end-ack: to-id
  // - response-ack: to-id
  // - response-end-ack: to-id
  MqttReqRes.prototype.waitForAck = function (ackMessageName, toId, timeout) {

    var self = this,
      ackEventName = '_mqtt-message-' + ackMessageName;

    timeout = timeout || 5000;

    debug(
      '%s waitForAck(%s, %s, %d)', this.clientId,
      ackMessageName, toId, timeout
    );

    return new Promise (function (resolve, reject) {

        var acked = false;

        function handleAck (topicPath, ackMessage) {

          // debug('%s handleAck(%s), waits for: "%s"', self.clientId, ackMessage.toId, ackEventName);
          
          if (ackMessage.toId === toId) {
            acked = true;
            self.removeListener(ackEventName, handleAck);
            resolve();
          }
        }

        self.on(ackEventName, handleAck);

        // reject on timeout
        setTimeout(function () {
          if (!acked) {
            self.removeListener(ackEventName, handleAck);
            reject(new Error('EACKTIMEOUT'));
          }
        }, timeout);     
    });
  };  // waitForAck


  // ### publish
  // generic mqtt publish
  MqttReqRes.prototype.mqttPublish = function (connection, subTopic, messageStr) {

    // debug(
    //   '%s mqttPublish(%s, %s)', this.clientId,
    //   connection.clientId, subTopic
    //   // , messageStr
    // );

    var self = this;

    return new Promise (function (resolve, reject) {
      try {
        // pubish message
        self.mqttClient.publish(        
          connection.topicSend + subTopic, 
          messageStr, 
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
        reject(e);
      }
    });
  };  // mqttPublish


  // ### request(string toClientId, string|object|ArrayBuffer payload, object meta)
  // A: request
  MqttReqRes.prototype.request = function (toClientId, payload, meta) {

    debug('%s request(%s)', this.clientId, toClientId);

    var self = this,
      messageId = MqttReqRes.randomString(MESSAGE_ID_LENGTH),
      connection;

    return this.connect(toClientId)
      .then(function() {

        connection = self.getConnection(toClientId);

        if (!connection) {
          return Promise.reject(new Error('ECLIENTCONNECTION'));
        }

        return self.mqttPublish(connection, 'request', JSON.stringify({
          messageId: messageId
        }));
      })
      .then(function () {
        return self.waitForAck('request-ack', messageId);
      })      
      .then(function () {
        if (typeof meta !== 'object') {
          // meta object is optional
          return Promise.resolve();
        }
        // meta streamSend (connection, messageId, msgTargetProperty, payload)
        return self.streamSend(connection, messageId, 'meta', meta);
      })
      .then(function () {
        // payload streamSend (connection, messageId, msgTargetProperty, payload)
        return self.streamSend(connection, messageId, 'payload', payload);
      })
      .then(function () {
        self.mqttPublish(connection, 'request-end', JSON.stringify({
          messageId: messageId
        }));
      })
      .then(function () {
        return self.waitForAck('request-end-ack', messageId);
      })
      .then(function () {
        return self.waitForResponse(connection, messageId);
      });
  };  // request


  // ### waitForResponse(connection, toMessageId)
  // A: response-ack
  MqttReqRes.prototype.waitForResponse = function (connection, toMessageId) {
  
    // debug('%s waitForResponse(toMessageId %s)', this.clientId, toMessageId);

    var self = this,
      responseMessageId,
      response = {
        errors: []
      };


    function waitForMqttResponseMessage () {

      return new Promise (function (resolve, reject) {

          var received = false;

          function handleResponseMessage (topicPath, responseMessage) {

            if (responseMessage.respondsTo === toMessageId) {
            
              received = true;
              responseMessageId = responseMessage.messageId;

              self.removeListener('_mqtt-message-response', handleResponseMessage);

              // A: response-ack
              self.sendAck(connection, 'response-ack', responseMessageId)
                .then(resolve)
                .catch(reject);
            }
          }

          self.on('_mqtt-message-response', handleResponseMessage);

          // reject on timeout
          setTimeout(function () {
            if (!received) {
              self.removeListener('_mqtt-message-response', handleResponseMessage);
              reject(new Error('ERESPONSETIMEOUT'));
            }
          }, 5000);     
      });
    } // waitForMqttResponseMessage


    function receiveStream (topicPath, mqttStreamMessage) {

      if (mqttStreamMessage.messageId !== responseMessageId) {
        return;
      }

      self.receiveStream(connection, mqttStreamMessage)
        .then(function (streamResult) {

          if (mqttStreamMessage.targetProperty === 'payload') {
            response.type = mqttStreamMessage.type;
          }

          response[mqttStreamMessage.targetProperty] = streamResult;
        })
        .catch(function (reason) {
          response.errors.push(reason);
        });
    }


    function waitForResponseEnd () {

      return new Promise (function (resolve, reject) {

          function handleResponseEndMessage (topicPath, responseEndMessage) {

            if (responseEndMessage.messageId === responseMessageId) {

              self.removeListener('_mqtt-message-response-end', handleResponseEndMessage);

              // A: response-end-ack
              self.sendAck(connection, 'response-end-ack', responseMessageId)
                .then(resolve)
                .catch(reject);
            }
          }

          self.on('_mqtt-message-response-end', handleResponseEndMessage);
      });
    } // waitForResponseEnd


    return waitForMqttResponseMessage()
      .then(function () {
        self.on('_mqtt-message-stream', receiveStream);
        return waitForResponseEnd();
      })
      .then(function () {
        self.removeListener('_mqtt-message-stream', receiveStream);
        return Promise.resolve(response);
      })
      .catch(function (reason) {
        self.removeListener('_mqtt-message-stream', receiveStream);
        return Promise.reject(reason);        
      });
  };  // waitForResponse


  MqttReqRes.prototype.receiveStream = function (connection, mqttStreamMessage) {
    
    var self = this,
      streamId = mqttStreamMessage.streamId,
      type = mqttStreamMessage.type,
      streamResult = null,
      error;

    function receiveChunk (topicPath, mqttChunkMessage) {

      var chunkData;
      try {

        if (mqttChunkMessage.streamId !== streamId) {
          return;
        }

        chunkData = MqttReqRes.decrypt(mqttChunkMessage.payload, connection.sharedSecret);

        if (type === 'ArrayBuffer') {
         
          if (streamResult === null) {
            streamResult = [];
          }

          chunkData.split(',').forEach(function (byteStr) {
            streamResult.push(byteStr);
          });
        } 
        else {
          // assume type 'string' or 'JSON'
          if (streamResult === null) {
            streamResult = '';
          }
          streamResult += chunkData;
        }

        self.sendAck(connection, 'chunk-ack', mqttChunkMessage.chunkId)
          .catch(function (reason) {
            error = reason;
          });
      }
      catch (e) {
        error = e;
      }
    }


    function waitForResponseStreamEnd () {

      return new Promise (function (resolve, reject) {

          function handleResponseStreamEndMessage (topicPath, streamEndMessage) {

            if (streamEndMessage.streamId === streamId) {
          
              self.removeListener('_mqtt-message-stream-end', handleResponseStreamEndMessage);

              // A: stream-end-ack
              self.sendAck(connection, 'stream-end-ack', streamId)
                .then(resolve)
                .catch(reject);
            }
          }

          self.on('_mqtt-message-stream-end', handleResponseStreamEndMessage);
      });
    } // waitForResponseStreamEnd


    return this.sendAck(connection, 'stream-ack', streamId)
      .then(function () {
        self.on('_mqtt-message-chunk', receiveChunk);
        return waitForResponseStreamEnd();
      })
      .then(function () {

        self.removeListener('_mqtt-message-chunk', receiveChunk);
        
        if (error) {
          return Promise.reject(error);
        }
        
        try {

          if (type === 'ArrayBuffer') {
            streamResult = Uint8Array.from(streamResult).buffer;
          }
          else if (type === 'JSON') {
            streamResult = JSON.parse(streamResult);
          }
          else if (type === 'null') {
            streamResult = null;
          }
          
          return Promise.resolve(streamResult);
        }
        catch (e) {
          return Promise.reject(e);
        }
      })
      .catch(function (reason) {
        self.removeListener('_mqtt-message-chunk', receiveChunk);
        return Promise.reject(reason);        
      });
  };  // receiveStreams


  // ### onRequest(function onRequestHandler)
  MqttReqRes.prototype.onRequest = function (onRequestCallback) {

    debug('%s onRequest()', this.clientId);

    this.fnOnRequest = onRequestCallback; 
    
    return this;
  };


  // ### MqttReqRes.handleRequestMessage(topicPath, requestMessage) 
  MqttReqRes.prototype.handleRequestMessage = function (topicPath, requestMessage) {
    
    // debug('%s handleRequestMessage(%s)', this.clientId, topicPath.join('/'));

    var self = this,
      fromClientId,
      connection,
      secret,
      requestMessageId,
      request = {
        errors: []
      };


    function receiveStream (topicPath, mqttStreamMessage) {

      if (mqttStreamMessage.messageId !== requestMessageId) {
        return;
      }

      self.receiveStream(connection, mqttStreamMessage)
        .then(function (streamResult) {

          if (mqttStreamMessage.targetProperty === 'payload') {
            request.type = mqttStreamMessage.type;
          }

          request[mqttStreamMessage.targetProperty] = streamResult;
        })
        .catch(function (reason) {
          request.errors.push(reason);
        });
    }


    function waitForRequestEnd () {

      return new Promise (function (resolve, reject) {

          function handleRequestEndMessage (topicPath, requestEndMessage) {

            if (requestEndMessage.messageId === requestMessageId) {

              self.removeListener('_mqtt-message-request-end', handleRequestEndMessage);

              // B: request-end-ack
              self.sendAck(connection, 'request-end-ack', requestMessageId)
                .then(resolve)
                .catch(reject);
            }
          }

          self.on('_mqtt-message-request-end', handleRequestEndMessage);
      });
    } // waitForRequestEnd


    try {

      if ('function' !== typeof this.fnOnRequest) {
        // no request handler defined, ignore message request
        return this;
      }

      fromClientId = topicPath[1];

      connection = this.getConnection(fromClientId, true);
      secret = this.getSharedSecret(connection);

      requestMessageId = requestMessage.messageId;

      this.connect(fromClientId, secret)
        .then(function() {
          return self.sendAck(connection, 'request-ack', requestMessageId);
        })
        .then(function () {

          self.on('_mqtt-message-stream', receiveStream);

          return waitForRequestEnd();
        })
        .then(function () {

          var req, res;

          self.removeListener('_mqtt-message-stream', receiveStream);

          req = {
            topic: topicPath.join('/'),
            payload: request.payload,
            type: request.type,
            meta: request.meta,
            errors: request.errors,
            connection: connection
          };

          res = {
            respondsTo: requestMessageId,
            send: function (payload, meta) {
              return self.sendResponse(connection, requestMessageId, payload, meta);
            }
          };

          // call request handler
          self.fnOnRequest(req, res);

        })
        .catch(function (reason) {

          self.removeListener('_mqtt-message-stream', receiveStream);
          debug(reason);
          // return Promise.reject(reason);        
        });      
    }
    catch (e) {
      debug(e);
    }

    return this;
  };


  // ### sendResponse(object connection, string respondToRequestId, string|object|ArrayBuffer payload, object meta)
  MqttReqRes.prototype.sendResponse = function (connection, respondToRequestId, payload, meta) {

    debug('%s sendResponse(%s, %s)', this.clientId, connection.clientId, respondToRequestId);

    var self = this,
      messageId = MqttReqRes.randomString(MESSAGE_ID_LENGTH);

    return this.connect(connection.clientId)
      .then(function() {
        return self.mqttPublish(connection, 'response', JSON.stringify({
          messageId: messageId,
          respondsTo: respondToRequestId
        }));
      })
      .then(function () {
        return self.waitForAck('response-ack', messageId);
      })      
      .then(function () {
        if (typeof meta !== 'object') {
          // meta object is optional
          return Promise.resolve();
        }
        // meta streamSend (connection, messageId, msgTargetProperty, payload)
        return self.streamSend(connection, messageId, 'meta', meta);
      })
      .then(function () {
        // payload streamSend (connection, messageId, msgTargetProperty, payload)
        return self.streamSend(connection, messageId, 'payload', payload);
      })
      .then(function () {
        self.mqttPublish(connection, 'response-end', JSON.stringify({
          messageId: messageId
        }));
      })
      .then(function () {
        return self.waitForAck('response-end-ack', messageId);
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
          return Promise.resolve(connection);
        }
      });
  };


  /*
    #### connectToBroker()
    connect to broker
  */
  MqttReqRes.prototype.connectToBroker = function () {

    debug('%s connectToBroker()', this.clientId);

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

      function onConnect () {
        self.emit(
          '_broker-connect', 
          // connack packet
          Array.prototype.slice.call(arguments)[0]
        );
      }
      
      self.mqttClient.on('connect', onConnect); 

      function onBrokerConnect () {
        connectSuccess = true;
        self.removeListener('connect', onConnect);
        self.removeListener('_broker-connect', onBrokerConnect);
        resolve();
      }

      self.once('_broker-connect', onBrokerConnect);

      setTimeout(function () {
        if (!connectSuccess) {
          self.removeListener('connect', onConnect);
          self.removeListener('_broker-connect', onBrokerConnect);          
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
    connection.connreq = MqttReqRes.randomString(CHANNEL_ID_LENGTH);

    //   - set connack = null
    connection.connack = null;

    //   - set channelNonce = randomString()
    connection.channelNonce = MqttReqRes.randomString(CHANNEL_NONCE_LENGTH);

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
            self.removeListener('_client-connack', handleClientConnack);
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


    this.on('_mqtt-message-request', function () {
      self.handleRequestMessage.apply(self, arguments);
    });

    return this;
  };


  // ### MqttReqRes.handleMqttClientMessage(topic, mqttMessage) 
  MqttReqRes.prototype.handleMqttClientMessage = function (topic, mqttMessage) {

    debug('%s handleMqttClientMessage(%s)', this.clientId, topic);

    var topicPath = topic.split('/'),
      message,
      messageTypeIndex;

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

        // is message topic publish -t message/<from-device-id>/<to-channel-id>/<mqtt-message-type>
        messageTypeIndex = messageTypes.indexOf(topicPath[3]);

        if (messageTypeIndex !== -1) {
          this.emit(
            '_mqtt-message-' + messageTypes[messageTypeIndex], 
            topicPath, 
            message
          );
          debug(
            '%s emitted %s , %s', this.clientId, 
            topicPath.join('/'), 
            '_mqtt-message-' + messageTypes[messageTypeIndex]
            // message
          );
        }
        else {
          throw(new Error('EMESSAGETYPE'));
        }
      }

    }
    catch (e) {
      // ignore errors
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
          connection.channelNonce = MqttReqRes.randomString(CHANNEL_NONCE_LENGTH);

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

    // debug('%s getSharedSecret(%s)', this.clientId, connection && connection.clientId);

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

    // debug('%s publishConnectAck(%s)', this.clientId, clientId);

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

    // debug('%s handleConnectAck(%s)', this.clientId, topicPath.join('/'));
    
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

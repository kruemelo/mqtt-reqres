// ## clientSpec


const debug = require('debug')('clientSpec');
const assert = require('chai').assert;
const fs = require('fs');
// const os = require('os');
const Broker = require('mqtt-reqres-broker');
const Client = require('../lib/mqtt-reqres.js');

const serverOptions = {
  hostname: 'localhost',
  port: 9999
};

const wsBroker = new Broker();


function pcatch (reason) {
  debug(reason);
  assert(!reason, reason);
}


function startServer (callback) {

  debug('startServer()');

  wsBroker.initialize(serverOptions, err => {
    if (err) {
      console.error(err.stack);
      callback(err);
    }
    else {
      
      wsBroker.start(null, err => {
        if (err) {
          console.error(err.stack);
        } 
        else {
          console.log(`broker running at http://${wsBroker.hostname}:${wsBroker.port}/`);
        }         
        callback(err);
      });
      
    }
  });
}


function newClient (clientId) {
  return new Client({
      clientId: clientId,
      brokerProtocol: 'ws',
      brokerHostname: serverOptions.hostname,
      brokerPort: serverOptions.port
    });
}


function closeClients (/*...connections*/) {

  const clients = Array.prototype.slice.call(arguments),
    pList = clients.map(client => {
      return new Promise (resolve => {
        if (client) {
          client.close(resolve);
        }
      });
    });

  return Promise.all(pList).catch(pcatch); 
}

describe('MqttReqResClient', () => {

  const clientAId = 'client-a',
    clientBId = 'client-b',
    sharedSecret = 'secret-a-b';
  
  var clientA, 
    clientB;


  before(startServer);

  after(done => {
    wsBroker.close(done);
  });


  it('should expose node Buffer', function () {

    // https://nodejs.org/docs/latest-v5.x/api/buffer.html#buffer_buffers_and_character_encodings

    const str = 'tést';
    const arrayBuffer = Uint8Array.from([1,2,4]).buffer;
    
    var buf = Client.Buffer.from(str, 'utf8');

    assert.instanceOf(buf, Buffer);

    assert.strictEqual(buf.toString('utf8'), str);
    assert.strictEqual(buf.toString('base64'), 'dMOpc3Q=');

    buf = Client.Buffer.from(arrayBuffer);

    assert.deepEqual(buf.buffer, arrayBuffer);
  });


  it('should connect to broker', done => {

    assert(Client);

    clientA = newClient(clientAId);

    assert(!clientA.mqttClient || !clientA.mqttClient.connected);

    clientA.on('broker.connect', function () {

      assert.isTrue(clientA.mqttClient.connected, 'mqttClient should be connected to broker');
      assert.isTrue(clientA.subscribedConnect, 'client should have subscribed connect topic');

      closeClients(clientA).then(() => done());
    });

    clientA.connect().catch(pcatch);

    // or:
    // clientA.connect()
    //   .then(..);
  });


  it('should connect to other client', done => {

    clientA = newClient(clientAId);
    clientB = newClient(clientBId);


    clientB.sharedSecret(function (clientId, callback) {
      debug('clientB.sharedSecret(%s)', clientId);
      callback(clientId === clientAId ? sharedSecret : null);
    });


    clientB.connect()
      .then(function () {
        debug('clientB connected to broker');
        return clientA.connect(clientBId, sharedSecret);
      })
      .then(function () {
            
        var connectedClients = clientA.getConnected(),
          connClientB;

        assert.strictEqual(connectedClients.length, 1);
        
        connClientB = connectedClients[0];

        assert.strictEqual(connClientB.clientId, clientBId);

        assert.isTrue(Client.isConnected(connClientB));

        debug('clientA connected to ' + clientBId);

        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });


  it('should accept connection requests from other clients', done => {

    clientA = newClient(clientAId);
    clientB = newClient(clientBId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB.on('client.connect', function (clientId) {
      
      var connectedClients = clientB.getConnected(),
        connClientA = connectedClients[0];

      assert.strictEqual(clientId, clientAId);

      assert.strictEqual(connectedClients.length, 1);

      assert.isTrue(Client.isConnected(connClientA));
      
      closeClients(clientA, clientB).then(() => done());
    });

    clientB.connect()
      .then(function () {
        
        // or: `return clientA.connect(clientBId, sharedSecret);`

        return clientA.connect(clientBId);
      })
      .catch(pcatch);
  });


  it('should ping and ack', done => {

    var bReceivedPingRequest = false;

    clientA = newClient(clientAId);
    clientB = newClient(clientBId);


    clientB.sharedSecret(function (clientId, callback) {
      debug('clientB.sharedSecret(%s)', clientId);
      callback(clientId === clientAId ? sharedSecret : null);
    });


    clientB.on('_mqtt-message-ping', function () {
      bReceivedPingRequest = true;
    });


    clientB.connect()
      .then(function () {
        return clientA.connect(clientBId, sharedSecret);
      })
      .then(function () {
        return clientA.ping(clientBId);
      })
      .then(function () {

        assert.isTrue(bReceivedPingRequest);


        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });


  it('should request and respond', done => {

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {

      try {

        debug('ClientB.on request', req.payload);

        assert.isString(req.topic);
        assert.isObject(req.connection);
        assert.strictEqual(req.type, 'string');
        assert.strictEqual(req.payload, 'hello');

        res.send('foo');
      }
      catch(e) {
        debug(e);
      }
    });

    clientB.connect()
      /*
        no need to connect clientA explicitely, will be implicitely done by clientA.request() which uses sharedSecret-handler function set before
        ```
        .then(function () {
           return clientA.connect(clientBId, sharedSecret);
        })
        ```  
      */      
      .then(function() {
        return clientA.request(clientBId, 'hello');
      })
      .then(function (res) {
        
        // check response received by client A 
        assert.strictEqual(res.type, 'string');
        assert.strictEqual(res.payload, 'foo');

        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });


  it('should request Buffer and respond string', function (done) {

    this.timeout(7000);

    var filenameSend = 'github-git-cheat-sheet.pdf', // 'github-timeout.png' 'github-git-cheat-sheet.pdf' 'npm.svg', 'npm.png'
      bufferSend = fs.readFileSync('./test/fixtures/' + filenameSend);

    assert.instanceOf(bufferSend, Buffer);

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {

      try {

        debug('ClientB.on request, payload length %d', req.payload.length);

        assert.strictEqual(req.type, 'Buffer');
        assert.strictEqual(req.payload.length, bufferSend.length);

        assert.deepEqual(
          req.payload.buffer,
          bufferSend.buffer
        );

        res.send('bar');
      }
      catch (e) {
        console.error(e);
        done(e);
      }
    });

    clientB.connect()
      .then(function() {
        return clientA.request(clientBId, bufferSend);
      })
      .then(function (res) {
        assert.strictEqual(res.type, 'string');
        assert.strictEqual(res.payload, 'bar');
        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });


  it('should request string and respond Buffer', function (done) {

    this.timeout(5000);

    var filenameRespond = 'npm.svg', // 'github-timeout.png' 'github-git-cheat-sheet.pdf' 'npm.svg', 'npm.png'
      bufferRespond = fs.readFileSync('./test/fixtures/' + filenameRespond);

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {
      try {
        debug('ClientB.on request, payload length %d', req.payload.length);

        assert.strictEqual(req.type, 'string');
        assert.strictEqual(req.payload, 'foo');

        // now respond with file
        res.send(bufferRespond);
      }
      catch(e) {
        done(e);
      }
    });

    clientB.connect()
      .then(function() {
        return clientA.request(clientBId, 'foo');
      })
      .then(function (res) {

        debug('clientA got response from cientB, res length %d', res.payload.length);

        assert.strictEqual(res.type, 'Buffer');
        assert.strictEqual(res.payload.length, bufferRespond.length);

        assert.deepEqual(
          res.payload.buffer,
          bufferRespond.buffer
        );

        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });


  it('should request with meta data', function (done) {

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {
      try {
        debug('ClientB.on request', req.payload);
        assert.deepEqual(req.meta, {foo: 'bar'});
        res.send('');
        closeClients(clientA, clientB).then(() => done());
      }
      catch(e) {
        done(e);
      }
    });


    clientB.connect()     
      .then(function() {

        // request with meta data
        return clientA.request(clientBId, 'hello', {foo: 'bar'});
      })
      .catch(pcatch);    
  });


  it('should request with payload null and meta data', function (done) {

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {
      try {
        debug('ClientB.on request', req.payload);
        assert.isNull(req.payload);
        assert.deepEqual(req.meta, {foo: 'bar'});
        res.send('nil');
        closeClients(clientA, clientB).then(() => done());
      }
      catch(e) {
        done(e);
      }
    });


    clientB.connect()     
      .then(function() {

        // request with meta data
        return clientA.request(clientBId, null, {foo: 'bar'});
      })
      .catch(pcatch);    
  });


  it('should respond with meta data', function (done) {

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {

      // respond with meta data
      res.send('', {foo: 'bar'});
    });


    clientB.connect()     
      .then(function () {
        return clientA.request(clientBId, 'hello');
      })
      .then(function (res) {
        
        assert.deepEqual(res.meta, {foo: 'bar'});
        assert.strictEqual(res.payload, '');
        
        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);    
  });


  it('should respond with payload null and meta data', function (done) {

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler
    clientB.onRequest(function (req, res) {

      // respond with meta data
      res.send(null, {foo: 'bar'});
    });


    clientB.connect()     
      .then(function () {
        return clientA.request(clientBId, 'hello');
      })
      .then(function (res) {
        
        assert.isNull(res.payload);
        assert.deepEqual(res.meta, {foo: 'bar'});
        
        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);    
  });


  it('should request and respond in parallel', function (done) {

    this.timeout(8000);

    clientA = newClient(clientAId);

    clientA.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    // define request handler b
    clientB.onRequest(function (req, res) {

      clientB.request(clientAId, 'b-' + req.payload)
        .then(function (result) {
          return res.send('echo-' + result.payload);
        })
        .catch(pcatch);
    });

    // define request handler a
    clientA.onRequest(function (req, res) {
      res.send('a-' + req.payload)
        .catch(pcatch);
    });


    clientB.connect()
      .then(function () {
        return clientA.connect(clientB.clientId);
      })
      .then(function() {

        return new Promise(function (resolve, reject) {

          var resultsDone = 0,
            requestPayloads = Array.from({length: 42}, (v, k) => k);

          requestPayloads.forEach(function (reqPayload) {

            clientA.request(clientBId, 'payload-' + reqPayload)
              .then(function (result) {

                try {

                  assert.strictEqual(
                    result.payload, 
                    'echo-a-b-payload-' + reqPayload
                  );

                  ++resultsDone;
                  
                  if (resultsDone === requestPayloads.length) {
                    resolve();
                  }
                }
                catch (e) {
                  reject(e);
                }
              })
              .catch(pcatch);
          });
        });
      })
      .then(function () {
        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });


  it('should disconnect a client', done => {

    var isConnected;

    clientA = newClient(clientAId);

    clientB = newClient(clientBId);

    clientB.sharedSecret(function (clientId, callback) {
      callback(sharedSecret);
    });

    isConnected = Client.isConnected(clientA.getConnection(clientBId));

    assert.isFalse(isConnected);

    clientB.connect()
      .then(function () {
        return clientA.connect(clientBId, sharedSecret);
      })
      .then(function () {

        isConnected = Client.isConnected(clientA.getConnection(clientBId));

        assert.isTrue(isConnected);

        return clientA.disconnect(clientBId);
      })
      .then(function () {

        isConnected = Client.isConnected(clientA.getConnection(clientBId));
        assert.isFalse(isConnected);

        closeClients(clientA, clientB).then(() => done());
      })
      .catch(pcatch);
  });
});
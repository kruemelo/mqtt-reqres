// ## clientSpec


const debug = require('debug')('clientSpec');
const assert = require('chai').assert;
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


  it('should connect to broker', done => {

    assert(Client);

    clientA = newClient(clientAId);

    assert(!clientA.mqttClient || !clientA.mqttClient.connected);

    clientA.on('broker-connect', function () {

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

    clientB.on('client-connect', function (clientId) {
      
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
      debug('ClientB.on request', req.payload);
      assert.strictEqual(req.payload, 'hello');
      res.send('foo');
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
        assert.strictEqual(res, 'foo');
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
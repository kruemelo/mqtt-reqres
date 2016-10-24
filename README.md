# mqtt-reqres

mqtt request/response client based on [mqttjs](https://github.com/mqttjs/MQTT.js)


# API

Stability: Experimental

## include client into web page

```
<script src="../build/mqtt-reqres-browser.js"></script>

// or minified

<script src="../build/mqtt-reqres-browser.min.js"></script>

..

<script type="text/javascript">
  
  client = new MqttReqRes();
  ..  
</script>
```

## use the client as a module

```
var MqttReqRes = require('mqtt-reqres');
```

## Methods

### MqttReqRes([options])

constructor

**options**:
- brokerProtocol string optional default 'mqtt' ('ws')
- brokerHostname string optional default 'localhost'
- brokerPort number optional default 1883
- clientId string optional default random string

**returns** instance of MqttReqRes 

Example:

```
var client = new MqttReqRes({
  brokerProtocol: 'mqtt',
  brokerHostname: '127.0.0.1',
  brokerPort: 9999,
  clientId: 'client-a'
})
```


### request(toClientId[, payload])

send a request to an other client.

**toClientId** string, required. the receiver's client id

**payload** string|object|ArrayBuffer, optional. the message string or object to be sent.

**returns** Promise which resolves to object `response`


Example:

```
client.request('client-b', 'hello!')
  .then(function (response) {

    /* called when received response 
    response.type -> 'string', 'ArrayBuffer', 'JSON'
    response.payload -> typeof string, ArrayBuffer or Object
    */
  })
  .catch(function (reason) {
    // request failed
    console.error(reason);
  });
```


### onRequest(callback)

defines a connection-specific request handler callback function. The handler function is called internally on each request received from connected client.

**callback** function required; callback takes these arguments:

- object **req** the request object with properties object `connection`, string `topic`, string `type` and string|object|ArrayBuffer `payload`
- object **res** the response object with function `send()`

use `res.send(message)` to respond to the request with string|object `message`.

Examples:

respond with string "foo":

```
clientB.onRequest(function (req, res) {

  /* called when received request 
  req.type -> 'string', 'ArrayBuffer', 'JSON'
  req.payload -> typeof string, ArrayBuffer or Object
  req.connection -> connection object
  req.topic -> string mqtt topic
  */

  res.send('foo');
});

```

respond with object
```
clientB.onRequest(function (req, res) {

  var o = {foo: 'bar'};
  res.send(o);
});
```

respond with file content

```
clientB.onRequest(function (req, res) {

  var arrayBufferRespond = Uint8Array.from(fs.readFileSync('filename')).buffer;
  res.send(arrayBufferRespond);
});
```


### sharedSecret(callback)

defines a connection-specific callback function to retrieve the shared secret required to connect. The callback function will be called internally on incoming as well as outgoing connection requests.

**callback** function required; first argument `clientId` is the connecting client id or the id of client to connect, the second `cb` a callback that takes the shared secret or falsy when connection should be refused. 

```

function onSharedSecret (clientId, cb) {
  if (clientId === 'client-b') {
    // continue connecting with client b using shared secret
    cb('shared-secret-a-b');
  }
  else {
    // refuse connect
    cb();
  }
}

clientA.sharedSecret(onSharedSecret);
```


### connect([toClientId[, sharedSecret]])

connect to broker or client with `toClientId` set.

**toClientId** string, optional. if set, connects to a client with the specified id. if omitted only connects to the broker.

**sharedSecret** string optional. if set it is used as the shared secret when connecting the client

Example:


```

clientB.sharedSecret(function (clientId, callback) {
  if (clientId === 'client-a') {
    callback('shared-secret-a-b')
  }
  else {
    callback(null);
  }
});

// connect client-b to broker
clientB.connect()
  .then(..);

..

// connect client-a to client-b
clientA.connect('client-b', 'shared-secret-a-b')
  .then(function () {
    // called when client-b is connected
  })
  .catch(function (reason) {
    // connect to client-b failed
    console.error(reason);
  });
```


### disconnect([fromClientId])

disconnect from broker or client with `toClientId` set.

**fromClientId** string, optional. if set, disconnects from a client with the specified id. if omitted, completely disconnects also also from the broker.

Example:


```
// completely disconnect client-b
clientB.disconnect()
  .then(..);

..

// disconnect from client-b only
clientA.disconnect('client-b')
  .then(..)
```


## Events


### broker-connect

fired when client connects to broker


### client-connect

fired when a client connects

Arguments:

- string **clientId** the client id of the connected client

Example:

```
client.on('client-connect', function (clientId) {
  log('on.client-connect ' + clientId);
});
```


## test

runs mocha specs in /test

```
$ npm test
// or
$ npm run test:debug
```
you may also open `test/index.html` in browser to play around with a client live frontend - this requires to have a websocket mqtt broker running:

```
$ npm run broker

// start broker with options
$ npm run broker -- -h 127.0.0.1 -p 9999
```

## other tasks

```
// build all
$ npm run build

// create build/mqtt-reqres-browser.js
$ npm run browserify

// create annotated source documentation in doc/
$ npm run build:docs

// minify browser version (http://coderaiser.github.io/minify/)
$ npm run minify:browser
```

see all npm tasks defined in [package.json](./package.html).

## build docs

create annotated source documentation in `doc/` folder, uses [groc](https://github.com/nevir/groc)

```
$ npm run build:docs
```

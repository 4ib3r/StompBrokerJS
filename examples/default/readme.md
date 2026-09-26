
Run this example from the current folder with

```
npm install
npm run server
```

then, in other terminals, start a client that subscribes to `/*` and one that sends a JSON message to `/test`:

```
npm run consumer
npm run producer
```

`test.html` is a browser client for the same server: open it in a browser while the server is running.

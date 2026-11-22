# Asset-service HTTP middleware

`cors.js` owns credentialed UI-origin response headers and preflight handling.
It includes PATCH for catalog attribution edits. Individual routes retain their
authentication and mutation-origin validation; CORS does not authorize a request.

// Preserve the service's existing credentialed-origin policy.
export function asset_cors(req, res, next) {
  const origin = req.headers.origin;
  const ui_origin =
    process.env.FRACTO_UI_ORIGIN ||
    `http://localhost:${process.env.FRACTO_UI_PORT || 3006}`;
  const credentialed = Boolean(
    origin &&
    (origin === ui_origin || process.env.FRACTO_ALLOW_CORS_ALL === "true"),
  );
  res.setHeader("Access-Control-Allow-Origin", credentialed ? origin : "*");
  res.vary("Origin");
  if (credentialed) res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Requested-With, X-Fracto-Service-Token, Range, If-None-Match, If-Modified-Since, If-Range",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Range, Content-Length, ETag",
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

// Authentication stub. Replace this middleware with real auth (JWT, API key, ...)
// and inject it via createChatApp({ authenticate }); routes rely only on req.user.
export function authenticate(req, res, next) {
  req.user = { id: 'anonymous' };
  next();
}

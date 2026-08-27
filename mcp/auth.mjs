// Pass-through stub. Replace by injection — createMcpHttpApp({ authenticate }) —
// not by editing this file. Routes depend only on req.user.
export function authenticate(req, res, next) {
  req.user = { id: 'anonymous' };
  next();
}

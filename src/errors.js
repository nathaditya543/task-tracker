/** Error carrying an HTTP status; rendered as JSON by the error middleware. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

module.exports = {
  HttpError,
  badRequest: (m, d) => new HttpError(400, m, d),
  unauthorized: (m = 'Authentication required') => new HttpError(401, m),
  forbidden: (m = 'Forbidden') => new HttpError(403, m),
  notFound: (m = 'Not found') => new HttpError(404, m),
  conflict: (m) => new HttpError(409, m),
};

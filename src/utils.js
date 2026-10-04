const { badRequest } = require('./errors');

/** Parses a positive-integer route param. */
function idParam(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid id');
  return n;
}

module.exports = { idParam };

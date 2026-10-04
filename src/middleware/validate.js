const { badRequest } = require('../errors');

/**
 * Validates req[source] with a zod schema. The parsed (coerced, defaulted) value is
 * exposed as req.valid[source] because req.query is read-only in Express 5.
 */
const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw badRequest('Validation failed', details);
  }
  req.valid = { ...req.valid, [source]: result.data };
  next();
};

module.exports = { validate };

function log(level, message, meta) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString()
  };

  if (meta) {
    entry.meta = meta;
  }

  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
    return;
  }

  if (level === 'warn') {
    console.warn(output);
    return;
  }

  console.log(output);
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
};

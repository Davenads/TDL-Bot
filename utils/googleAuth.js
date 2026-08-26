const { google } = require('googleapis');
const { JWT } = require('google-auth-library');

/**
 * Creates a Google Auth instance with the proper credentials.
 * Mirrors DFC-Data's proven service-account JWT approach.
 * @param {string[]} scopes - Google API scopes to authorize
 * @returns {JWT} Google Auth JWT client
 */
function createGoogleAuth(scopes = [
  'https://www.googleapis.com/auth/spreadsheets'
]) {
  console.log('Initializing Google Auth with direct JWT approach');

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY || '';

  if (!clientEmail) {
    throw new Error('GOOGLE_CLIENT_EMAIL environment variable is not set');
  }

  console.log(`Client email present: ${!!clientEmail}`);
  console.log(`Private key present: ${!!privateKey}`);
  console.log(`Private key length: ${privateKey ? privateKey.length : 0}`);

  try {
    // Heroku Node.js 18+ handling for PKCS#8 keys: force legacy OpenSSL provider.
    // See: https://github.com/nodejs/node/issues/43132
    const setLegacyProvider = process.env.NODE_OPTIONS?.includes('--openssl-legacy-provider') !== true;
    if (setLegacyProvider) {
      console.log('Setting OpenSSL legacy provider option');
      process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --openssl-legacy-provider';
    }
  } catch (error) {
    console.error('Unable to set OpenSSL options:', error.message);
  }

  return new JWT(
    clientEmail,
    null,
    privateKey.replace(/\\n/g, '\n'), // handle escaped newlines (local .env)
    scopes
  );
}

module.exports = {
  createGoogleAuth
};

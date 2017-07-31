/**
 * Copyright (C) 2012-2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

'use strict';


import mvelo from 'lib-mvelo';
const l10n = mvelo.l10n.get;
import openpgp from 'openpgp';
import * as defaults from './defaults';
import * as prefs from './prefs';
import * as pwdCache from './pwdCache';
import {randomString} from './crypto';
import * as uiLog from './uiLog';
import * as keyring from './keyring';
import * as keyringSync from './keyringSync';
import * as trustKey from './trustKey';
import * as sub from '../controller/sub.controller';

const unlockQueue = new mvelo.util.PromiseQueue();
let watchListBuffer = null;

export function init() {
  return mvelo.storage.get('mvelo.preferences')
  .then(preferences => {
    if (!preferences && mvelo.storage.old.get('mailvelopePreferences')) {
      return migrateStorage();
    }
  })
  .then(() => defaults.init())
  .then(() => prefs.init())
  .then(() => {
    pwdCache.init();
    initOpenPGP();
  })
  .then(() => keyring.init())
  .then(() => {
    trustKey.init();
  });
}

function migrateStorage() {
  let keyringAttr;
  return Promise.resolve()
  .then(() => {
    // keyring attributes
    keyringAttr = mvelo.storage.old.get('mailvelopeKeyringAttr');
    return mvelo.storage.set('mvelo.keyring.attributes', keyringAttr);
  })
  .then(() => {
    // keyrings
    let setKeyringAsync = [];
    for (let keyringId in keyringAttr) {
      if (keyringAttr.hasOwnProperty(keyringId)) {
        let publicKeys, privateKeys;
        if (keyringId === mvelo.LOCAL_KEYRING_ID) {
          publicKeys = mvelo.storage.old.get('openpgp-public-keys') || [];
          privateKeys = mvelo.storage.old.get('openpgp-private-keys') || [];
        } else {
          publicKeys = mvelo.storage.old.get(`${keyringId}public-keys`) || [];
          privateKeys = mvelo.storage.old.get(`${keyringId}private-keys`) || [];
        }
        setKeyringAsync.push(
          mvelo.storage.set(`mvelo.keyring.${keyringId}.publicKeys`, publicKeys)
          .then(() => mvelo.storage.set(`mvelo.keyring.${keyringId}.privateKeys`, privateKeys))
        );
      }
    }
    return Promise.all(setKeyringAsync);
  })
  .then(() => {
    // watchlist
    const watchlist = mvelo.storage.old.get('mailvelopeWatchList');
    return mvelo.storage.set('mvelo.watchlist', watchlist);
  })
  .then(() => {
    // preferences
    const preferences = mvelo.storage.old.get('mailvelopePreferences');
    return mvelo.storage.set('mvelo.preferences', preferences);
  })
  .then(() => {
    // remove keyring attributes
    mvelo.storage.old.remove('mailvelopeKeyringAttr');
    // remove keyrings
    for (let keyringId in keyringAttr) {
      if (keyringAttr.hasOwnProperty(keyringId)) {
        if (keyringId === mvelo.LOCAL_KEYRING_ID) {
          mvelo.storage.old.remove('openpgp-public-keys');
          mvelo.storage.old.remove('openpgp-private-keys');
        } else {
          mvelo.storage.old.remove(`${keyringId}public-keys`);
          mvelo.storage.old.remove(`${keyringId}private-keys`);
        }
      }
    }
    // remove watchlist
    mvelo.storage.old.remove('mailvelopeWatchList');
    // remove preferences
    mvelo.storage.old.remove('mailvelopePreferences');
  })
  .catch(error => console.log('migrateStorage() error:', error));
}

function initOpenPGP() {
  openpgp.config.commentstring = 'https://www.mailvelope.com';
  openpgp.config.versionstring = 'Mailvelope v' + defaults.getVersion();
  if (mvelo.crx) {
    openpgp.initWorker('dep/openpgp.worker.js');
  } else if (mvelo.ffa) {
    var CWorker = mvelo.util.getWorker();
    openpgp.initWorker('', {
      worker: new CWorker(mvelo.data.url('openpgp.worker.min.js'))
    });
  }
}

/*
function decode_utf8(str) {
  // if str contains umlauts (öäü) this throws an exeception -> no decoding required
  try {
    return decodeURIComponent(escape(str));
  } catch (e) {
    return str;
  }
}
*/

export function readMessage({armoredText, binaryString, keyringId}) {
  return new Promise(function(resolve, reject) {
    var result = {};
    if (armoredText) {
      try {
        result.message = openpgp.message.readArmored(armoredText);
      } catch (e) {
        console.log('openpgp.message.readArmored', e);
        return reject({
          code: 'ARMOR_PARSE_ERROR',
          message: l10n('message_read_error', [e])
        });
      }
    } else if (binaryString) {
      try {
        let packetList = new openpgp.packet.List();
        packetList.read(binaryString);
        result.message = new openpgp.message.Message(packetList)
      } catch (e) {
        console.log('Error parsing binary file', e);
        return reject({
          code: 'BINARY_PARSE_ERROR',
          message: l10n('file_read_error', [e])
        });
      }
    }

    var encryptionKeyIds = result.message.getEncryptionKeyIds();
    var privKey = findPrivateKey(encryptionKeyIds, keyringId);

    if (privKey && privKey.key) {
      result.keyid = privKey.keyid;
      result.key = privKey.key;
      result.userid = keyring.getUserId(result.key, false);
    } else {
      // unknown private key
      result.keyid = encryptionKeyIds[0].toHex();
      var message = l10n("message_no_keys", [result.keyid.toUpperCase()]);
      for (var i = 1; i < encryptionKeyIds.length; i++) {
        message = message + ' ' + l10n("word_or") + ' ' + encryptionKeyIds[i].toHex().toUpperCase();
      }
      return reject({
        code: 'NO_KEY_FOUND',
        message: message
      });
    }

    resolve(result);
  });
}

function findPrivateKey(encryptionKeyIds, keyringId) {
  var result = {};
  for (var i = 0; i < encryptionKeyIds.length; i++) {
    var keyrings;
    if (keyringId) {
      keyrings = [keyring.getById(keyringId)];
    } else {
      keyrings = keyring.getAll();
    }
    for (var j = 0; j < keyrings.length; j++) {
      result.keyid = encryptionKeyIds[i].toHex();
      result.key = keyrings[j].keyring.privateKeys.getForId(result.keyid, true);
      if (result.key) {
        return result;
      }
    }
  }
}

export function readCleartextMessage(armoredText, keyringId) {
  var result = {};
  try {
    result.message = openpgp.cleartext.readArmored(armoredText);
  } catch (e) {
    console.log('openpgp.cleartext.readArmored', e);
    throw {
      message: l10n('cleartext_read_error', [e])
    };
  }

  result.signers = [];
  var signingKeyIds = result.message.getSigningKeyIds();
  if (signingKeyIds.length === 0) {
    throw {
      message: 'No signatures found'
    };
  }
  for (var i = 0; i < signingKeyIds.length; i++) {
    var signer = {};
    signer.keyid = signingKeyIds[i].toHex();
    signer.key = keyring.getById(keyringId).keyring.getKeysForId(signer.keyid, true);
    signer.key = signer.key ? signer.key[0] : null;
    if (signer.key) {
      signer.userid = keyring.getUserId(signer.key);
    }
    result.signers.push(signer);
  }

  return result;
}

export function unlockKey(privKey, keyid, passwd) {
  return openpgp.getWorker().decryptKeyPacket(privKey, [openpgp.Keyid.fromId(keyid)], passwd);
}

export function decryptMessage(message, keyringId, callback) {
  const options = message.options || {};
  let senderAddress = options.senderAddress;
  // normalize sender address to array
  senderAddress = [].concat(senderAddress || []);
  // verify signatures if sender address provided or self signed message (draft)
  if (senderAddress.length || options.selfSigned) {
    var keyRing = keyring.getById(keyringId);
    var signingKeys = [];
    if (senderAddress.length) {
      signingKeys = keyRing.getKeyByAddress(senderAddress, {validity: true});
      signingKeys = senderAddress.reduce((result, email) => result.concat(signingKeys[email] || []), []);
    }
    // if no signing keys found we use decryption key for verification
    // this covers the self signed message (draft) use case
    // also signingKeys parameter in decryptAndVerifyMessage has to contain at least one key
    if (!signingKeys.length) {
      signingKeys = [message.key];
    }
    openpgp.getWorker().decryptAndVerifyMessage(message.key, signingKeys, message.message).then(function(result) {
      result.signatures = result.signatures.map(function(signature) {
        signature.keyid = signature.keyid.toHex();
        if (signature.valid !== null) {
          var signingKey = keyRing.keyring.getKeysForId(signature.keyid, true);
          signature.keyDetails = keyring.mapKeys(signingKey)[0];
        }
        return signature;
      });
      callback(null, result);
    }, callback);
  } else {
    openpgp.getWorker().decryptMessage(message.key, message.message).then(function(result) {
      callback(null, {text: result});
    }, callback);
  }
}

function getKeysForEncryption(options) {
  var keys = options.keyIdsHex.map(function(keyIdHex) {
    var keyArray = keyring.getById(options.keyringId).keyring.getKeysForId(keyIdHex);
    return keyArray ? keyArray[0] : null;
  }).filter(function(key) {
    return key !== null;
  });
  if (keys.length === 0) {
    throw {
      code: 'NO_KEY_FOUND_FOR_ENCRYPTION',
      message: 'No key found for encryption'
    };
  }
  return keys;
}

/**
 * @param {Object} options
 * @param {String} options.keyIdsHex
 * @param {String} options.keyringId
 * @param {String} options.message  message as native JavaScript string
 * @param {String} options.uiLogSource
 * @returns {Promise<String.{type: String, code: String, message: String}>}
 */
export function encryptMessage(options) {
  return new Promise(function(resolve, reject) {
    var keys = getKeysForEncryption(options);
    openpgp.getWorker().encryptMessage(keys, options.message)
      .then(function(msg) {
        logEncryption(options.uiLogSource, keys);
        resolve(msg);
      })
      .catch(function(e) {
        console.log('openpgp.getWorker().encryptMessage() error', e);
        reject({
          message: l10n('encrypt_error', [e])
        });
      });
  });
}

/**
 * @param {Object} options
 * @param {String} options.keyIdsHex
 * @param {String} options.keyringId
 * @param {String} options.message  message as native JavaScript string
 * @param {Object} options.primaryKey
 * @param {String} options.uiLogSource
 * @return {Promise.<String>}
 */
export function signAndEncryptMessage(options) {
  return new Promise(function(resolve, reject) {
    var keys = getKeysForEncryption(options);
    openpgp.getWorker().signAndEncryptMessage(keys, options.primaryKey.key, options.message)
      .then(function(msg) {
        logEncryption(options.uiLogSource, keys);
        resolve(msg);
      })
      .catch(function(e) {
        console.log('openpgp.getWorker().signAndEncryptMessage() error', e);
        reject({
          code: 'ENCRYPT_ERROR',
          message: l10n('encrypt_error', [e])
        });
      });
  });
}

function logEncryption(source, keys) {
  if (source) {
    var recipients = keys.map(function(key) {
      return keyring.getUserId(key, false);
    });
    uiLog.push(source, l10n('security_log_encryption_operation', [recipients.join(', ')]));
  }
}

export function verifyMessage(message, signers, callback) {
  var keys = signers.map(function(signer) {
    return signer.key;
  }).filter(function(key) {
    return key !== null;
  });
  try {
    var verified = message.verify(keys);
    signers = signers.map(function(signer) {
      signer.valid = signer.key && verified.some(function(verifiedSig) {
        return signer.keyid === verifiedSig.keyid.toHex() && verifiedSig.valid;
      });
      // remove key object
      delete signer.key;
      return signer;
    });
    callback(null, signers);
  } catch (e) {
    callback({
      message: l10n('verify_error', [e])
    });
  }
}

/**
 * @param {String} message
 * @param {String} signKey
 * @return {Promise<String>}
 */
export function signMessage(message, signKey) {
  return openpgp.getWorker().signClearMessage([signKey], message);
}

export function createPrivateKeyBackup(primaryKey, keyPwd) {
  // create backup code
  var backupCode = randomString(26);
  // create packet structure
  var packetList = new openpgp.packet.List();
  var literal = new openpgp.packet.Literal();
  var text = 'Version: 1\n';
  text += 'Pwd: ' + keyPwd + '\n';
  literal.setText(text);
  packetList.push(literal);
  packetList.concat(primaryKey.toPacketlist());
  // symmetrically encrypt with backup code
  var msg = new openpgp.message.Message(packetList);
  msg = msg.symEncrypt(backupCode);
  return {
    backupCode: backupCode,
    message: msg.armor()
  };
}

function parseMetaInfo(txt) {
  var result = {};
  txt.replace(/\r/g, '').split('\n').forEach(function(row) {
    if (row.length) {
      var keyValue = row.split(/:\s/);
      result[keyValue[0]] = keyValue[1];
    }
  });
  return result;
}

export function restorePrivateKeyBackup(armoredBlock, code) {
  //console.log('restorePrivateKeyBackup', armoredBlock);
  try {
    var message = openpgp.message.readArmored(armoredBlock);
    if (!(message.packets.length === 2 &&
          message.packets[0].tag === 3 && // Symmetric-Key Encrypted Session Key Packet
          message.packets[0].sessionKeyAlgorithm === 'aes256' &&
          (message.packets[0].sessionKeyEncryptionAlgorithm === null || message.packets[0].sessionKeyEncryptionAlgorithm === 'aes256') &&
          message.packets[1].tag === 18 // Sym. Encrypted Integrity Protected Data Packet
       )) {
      return { error: {message: 'Illegal private key backup structure.'}};
    }
    try {
      message = message.symDecrypt(code);
    } catch (e) {
      return { error: {message: 'Could not decrypt message with this restore code', code: 'WRONG_RESTORE_CODE'}};
    }
    // extract password
    var pwd = parseMetaInfo(message.getText()).Pwd;
    // remove literal data packet
    var keyPackets = message.packets.slice(1);
    var privKey =  new openpgp.key.Key(keyPackets);
    return { key: privKey, password: pwd };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * @param  {openpgp.key.Key} key - key to decrypt and verify signature
 * @param  {openpgp.message.Message} message - sync packet
 * @return {Promise<Object,Error>}
 */
export function decryptSyncMessage(key, message) {
  return openpgp.getWorker().decryptAndVerifyMessage(key, [key], message)
    .then(function(msg) {
      // check signature
      var sig = msg.signatures[0];
      if (!(sig && sig.valid && sig.keyid.equals(key.getSigningKeyPacket().getKeyId()))) {
        throw new Error('Signature of synced keyring is invalid');
      }
      var syncData = JSON.parse(msg.text);
      var publicKeys = [];
      var changeLog = {};
      var fingerprint;
      for (fingerprint in syncData.insertedKeys) {
        publicKeys.push({
          type: 'public',
          armored: syncData.insertedKeys[fingerprint].armored
        });
        changeLog[fingerprint] = {
          type: keyringSync.INSERT,
          time: syncData.insertedKeys[fingerprint].time
        };
      }
      for (fingerprint in syncData.deletedKeys) {
        changeLog[fingerprint] = {
          type: keyringSync.DELETE,
          time: syncData.deletedKeys[fingerprint].time
        };
      }
      return {
        changeLog: changeLog,
        keys: publicKeys
      };
    });
}

/**
 * @param  {Key} key - used to sign and encrypt the package
 * @param  {Object} changeLog
 * @param  {String} keyringId - selects keyring for the sync
 * @return {Promise<Object, Error>} - the encrypted message and the own public key
 */
export function encryptSyncMessage(key, changeLog, keyringId) {
  var syncData = {};
  syncData.insertedKeys = {};
  syncData.deletedKeys = {};
  var keyRing = keyring.getById(keyringId).keyring;
  keyRing.publicKeys.keys.forEach(function(pubKey) {
    convertChangeLog(pubKey, changeLog, syncData);
  });
  keyRing.privateKeys.keys.forEach(function(privKey) {
    convertChangeLog(privKey.toPublic(), changeLog, syncData);
  });
  for (var fingerprint in changeLog) {
    if (changeLog[fingerprint].type === keyringSync.DELETE) {
      syncData.deletedKeys[fingerprint] = {
        time: changeLog[fingerprint].time
      };
    }
  }
  syncData = JSON.stringify(syncData);
  return openpgp.getWorker().signAndEncryptMessage([key], key, syncData);
}

function convertChangeLog(key, changeLog, syncData) {
  var fingerprint = key.primaryKey.getFingerprint();
  var logEntry = changeLog[fingerprint];
  if (!logEntry) {
    console.log('Key ' + fingerprint + ' in keyring but not in changeLog.');
    return;
  }
  if (logEntry.type === keyringSync.INSERT) {
    syncData.insertedKeys[fingerprint] = {
      armored: key.armor(),
      time: logEntry.time
    };
  } else if (logEntry.type === keyringSync.DELETE) {
    console.log('Key ' + fingerprint + ' in keyring but has DELETE in changeLog.');
  } else {
    console.log('Invalid changeLog type:', logEntry.type);
  }
}

export function getLastModifiedDate(key) {
  var lastModified = new Date(0);
  key.toPacketlist().forEach(function(packet) {
    if (packet.created && packet.created > lastModified) {
      lastModified = packet.created;
    }
  });
  return lastModified;
}

export function encryptFile(plainFile, receipients) {
  var keys;
  return Promise.resolve()
  .then(function() {
    keys = receipients.map(function(receipient) {
      var keyArray = keyring.getById(receipient.keyringId).keyring.getKeysForId(receipient.keyid);
      return keyArray ? keyArray[0] : null;
    }).filter(function(key) {
      return key !== null;
    });
    if (keys.length === 0) {
      throw { message: 'No key found for encryption' };
    }
    var content = dataURL2str(plainFile.content);
    return openpgp.getWorker().encryptMessage(keys, content, 'binary', plainFile.name);
  })
  .then(function(msg) {
    logEncryption('security_log_encrypt_dialog', keys);
    return msg;
  })
  .catch(function(e) {
    console.log('openpgp.getWorker().encryptFile() error', e);
    throw { message: l10n('encrypt_error', [e.message]) };
  });
}

export function decryptFile(encryptedFile) {
  return Promise.resolve()
  .then(function() {
    let msg = {};
    let content = dataURL2str(encryptedFile.content);
    if (/^-----BEGIN PGP MESSAGE-----/.test(content)) {
      msg.armoredText = content;
    } else {
      msg.binaryString = content;
    }
    return readMessage(msg);
  })
  .then(function(message) {
    return unlockQueue.push(sub.factory.get('pwdDialog'), 'unlockKey', [message]);
  })
  .then(function(message) {
    return openpgp.getWorker().decryptMessage(message.key, message.message, 'binary');
  })
  .then(function(result) {
    return {
      name: result.filename || encryptedFile.name.slice(0, -4),
      content: result.text
    };
  })
  .catch(function(e) {
    console.log('openpgp.getWorker().decryptFile() error', e);
    throw mvelo.util.mapError(e);
  });
}

function dataURL2str(dataURL) {
  var base64 = dataURL.split(';base64,')[1];
  return mvelo.util.getDOMWindow().atob(base64);
}

export function getWatchList() {
  if (watchListBuffer) {
    return Promise.resolve(watchListBuffer);
  } else {
    return mvelo.storage.get('mvelo.watchlist')
    .then(watchList => watchListBuffer = watchList);
  }
}

export function setWatchList(watchList) {
  return mvelo.storage.set('mvelo.watchlist', watchList)
  .then(() => watchListBuffer = watchList);
}

export function getHostname(url) {
  var hostname = mvelo.util.getHostname(url);
  // limit to 3 labels per domain
  return hostname.split('.').slice(-3).join('.');
}

export function getPreferences() {
  return mvelo.storage.get('mvelo.preferences');
}

export function setPreferences(preferences) {
  return mvelo.storage.set('mvelo.preferences', preferences);
}

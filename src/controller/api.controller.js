/**
 * Copyright (C) 2015-2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

'use strict';


import mvelo from 'lib-mvelo';
import * as keyring from '../modules/keyring';
import * as sub from './sub.controller';
import openpgp from 'openpgp';
import {getLastModifiedDate} from '../modules/pgpModel';

export function handleApiEvent(request, sender, sendResponse) {
  var keyRing, attr;
  try {
    switch (request.event) {
      case 'get-keyring':
        keyRing = keyring.getById(request.keyringId);
        if (keyRing) {
          attr = keyRing.getAttributes();
          sendResponse({data: {revision: attr.logo_revision}});
          sub.setActiveKeyringId(request.keyringId);
        }
        break;
      case 'create-keyring':
        keyring.createKeyring(request.keyringId)
        .then(keyRing => keyRing.sync.activate())
        .then(() => {
          sendResponse({data: {}});
          sub.setActiveKeyringId(request.keyringId);
        })
        .catch(err => sendResponse({error: mvelo.util.mapError(err)}));
        return true;
      case 'query-valid-key':
        var keyMap = keyring.getById(request.keyringId).getKeyByAddress(request.recipients, {validity: true, fingerprint: true, sort: true});
        Object.keys(keyMap).forEach(function(email) {
          if (keyMap[email]) {
            keyMap[email] = {
              keys: keyMap[email].map(function(key) {
                return {
                  fingerprint: key.primaryKey.getFingerprint(),
                  lastModified: getLastModifiedDate(key).toISOString()
                };
              })
            };
          }
        });
        sendResponse({error: null, data: keyMap});
        break;
      case 'export-own-pub-key':
        var keyIdMap = keyring.getById(request.keyringId).getKeyIdByAddress([request.emailAddr], {validity: true, pub: false, priv: true, sort: true});
        if (!keyIdMap[request.emailAddr]) {
          sendResponse({error: {message: 'No key pair found for this email address.', code: 'NO_KEY_FOR_ADDRESS'}});
          return;
        }
        // only take first valid key
        if (keyIdMap[request.emailAddr].length > 1) {
          keyIdMap[request.emailAddr].length = 1;
        }
        var armored = keyring.getById(request.keyringId).getArmoredKeys(keyIdMap[request.emailAddr], {pub: true});
        sendResponse({error: null, data: armored[0].armoredPublic});
        break;
      case 'import-pub-key':
        sub.factory.get('importKeyDialog').importKey(request.keyringId, request.armored)
        .then(status => sendResponse({data: status}))
        .catch(err => sendResponse({error: mvelo.util.mapError(err)}));
        return true;
      case 'set-logo':
        attr = keyring.getById(request.keyringId).getAttributes();
        if (attr.logo_revision && attr.logo_revision > request.revision) {
          sendResponse({error: {message: 'New logo revision < existing revision.', code: 'REVISION_INVALID'}});
          return;
        }
        keyring.setKeyringAttr(request.keyringId, {logo_revision: request.revision, logo_data_url: request.dataURL})
        .then(() => {
          sendResponse({error: null, data: null});
        })
        .catch(err => sendResponse({error: mvelo.util.mapError(err)}));
        return true;
      case 'has-private-key':
        if (request.fingerprint) {
          const fingerprint = request.fingerprint.toLowerCase().replace(/\s/g, '');
          const key = keyring.getById(request.keyringId).keyring.privateKeys.getForId(fingerprint);
          const valid = key && key.verifyPrimaryKey() === openpgp.enums.keyStatus.valid;
          sendResponse({error: null, data: (key && valid ? true : false)});
        } else {
          const hasPrivateKey = keyring.getById(request.keyringId).hasPrivateKey();
          sendResponse({error: null, data: hasPrivateKey});
        }
        break;
      case 'open-settings':
        request.keyringId = request.keyringId || mvelo.LOCAL_KEYRING_ID;
        var hash = '?krid=' + encodeURIComponent(request.keyringId) + '#/settings';
        mvelo.tabs.loadOptionsTab(hash, function(old, tab) {
          if (old) {
            mvelo.tabs.sendMessage(tab, {
              event: 'reload-options',
              hash: hash
            });
          }
        });
        sendResponse({error: null, data: null});
        break;
      default:
        console.log('unknown event:', request);
    }
  } catch (err) {
    sendResponse({error: mvelo.util.mapError(err)});
  }
}

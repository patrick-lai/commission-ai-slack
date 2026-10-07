import { CallError, errorCode } from './errors.js';
import { MAX_FILES, defang, mentionIds, plain, skippedNote, splitWhitespace, supportedMime, takeChars } from './text.js';

async function stageFiles(context, files, limits) {
  const { slack, bot, daemon } = context;
  const shas = [];
  const skips = [];
  const allowed = Math.min(limits.max_files, MAX_FILES);
  for (const original of files) {
    if (shas.length >= allowed || shas.length + skips.length >= MAX_FILES) {
      skips.push('extra');
      continue;
    }
    let file = original;
    if (file.url === '') {
      try {
        file = await slack.fileInfo(bot, file.id);
      } catch (error) {
        if (!(error instanceof CallError)) {
          throw error;
        }
        skips.push(errorCode(error.detail) === 'missing_scope' ? 'no_access' : 'failed');
        continue;
      }
    }
    if (!supportedMime(file.mime)) {
      skips.push('unsupported');
      continue;
    }
    if (file.size > limits.cap_bytes) {
      skips.push('too_large');
      continue;
    }
    const downloaded = await slack.download(bot, file, limits.cap_bytes);
    if (downloaded.skip) {
      skips.push(downloaded.skip);
      continue;
    }
    const staged = await daemon.stageMedia(file.name, file.mime, downloaded.bytes);
    if (staged.sha) {
      shas.push(staged.sha);
    } else if (staged.code === 'hub.media_too_large') {
      skips.push('too_large');
    } else if (staged.code === 'hub.media_unsupported') {
      skips.push('unsupported');
    } else {
      skips.push('failed');
    }
  }
  return { shas, skips };
}

export async function prepareMessage(context, message, limits) {
  const { slack, bot, botUser } = context;
  const ids = [message.sender_id];
  for (const id of mentionIds(message.text)) {
    if (!ids.includes(id) && id !== botUser) {
      ids.push(id);
    }
  }
  const resolved = new Map();
  for (const id of ids) {
    const name = await slack.userName(bot, id);
    if (name !== null) {
      resolved.set(id, name);
    }
  }
  const senderName = resolved.get(message.sender_id);
  const sender = senderName === undefined ? message.sender_id : takeChars(defang(splitWhitespace(senderName).join(' ')), 60);
  const staged = message.files.length === 0 ? { shas: [], skips: [] } : await stageFiles(context, message.files, limits);
  return { sender, body: plain(message.text, botUser, resolved), note: skippedNote(staged.skips), attachments: staged.shas };
}

#!/usr/bin/env python3
"""
Extracts structured data from Baileys raw event logs.

Reads logs/<event>/<date>.json and produces extracted/<date>/ with:
  - users.json            — all known users (id, phone, name, groups)
  - groups-full.json      — group metadata with admins, description, members
  - messages.json         — all messages with parsed content
  - stickers.json         — sticker metadata
  - receipts.json         — read/delivery receipts
  - presence.json         — typing/online indicators
  - reactions.json        — emoji reactions mapped to messages
  - threads.json          — reply chains (who quotes whom)
  - polls.json            — poll results with decrypted votes
  - member-profiles.json  — users enriched with group tags, admin status, activity
  - activity.json         — heatmap by hour, media breakdown, conversation starters
  - timeline.json         — unified chronological feed
  - stats.json            — summary statistics
"""

import hashlib
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

LOGS_DIR = os.path.join(os.path.dirname(__file__), '..', 'logs')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'extracted')


def load_events(event_name: str, date: str) -> list:
    path = os.path.join(LOGS_DIR, event_name, f'{date}.json')
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f)


def load_all_events(event_name: str) -> list:
    dir_path = os.path.join(LOGS_DIR, event_name)
    if not os.path.isdir(dir_path):
        return []
    entries = []
    for f in sorted(os.listdir(dir_path)):
        if not f.endswith('.json'):
            continue
        with open(os.path.join(dir_path, f)) as fh:
            entries.extend(json.load(fh))
    return entries


def parse_message_content(msg_obj: dict) -> dict:
    if not msg_obj:
        return {'type': 'unknown'}

    if 'conversation' in msg_obj:
        return {'type': 'text', 'text': msg_obj['conversation']}

    if 'extendedTextMessage' in msg_obj:
        ext = msg_obj['extendedTextMessage']
        content = {'type': 'text', 'text': ext.get('text', '')}
        ctx = ext.get('contextInfo', {})
        if 'quotedMessage' in ctx:
            content['quoted_message_id'] = ctx.get('stanzaId')
            content['quoted_participant'] = ctx.get('participant')
            quoted_keys = [k for k in ctx.get('quotedMessage', {}).keys() if k != 'messageContextInfo']
            content['quoted_type'] = quoted_keys[0] if quoted_keys else None
        return content

    if 'stickerMessage' in msg_obj:
        stk = msg_obj['stickerMessage']
        content = {
            'type': 'sticker',
            'animated': stk.get('isAnimated', False),
            'ai_sticker': stk.get('isAiSticker', False),
            'lottie': stk.get('isLottie', False),
            'file_size': int(stk.get('fileLength', 0)),
            'dimensions': f"{stk.get('width', '?')}x{stk.get('height', '?')}",
        }
        ctx = stk.get('contextInfo', {})
        if 'quotedMessage' in ctx:
            content['quoted_message_id'] = ctx.get('stanzaId')
            content['quoted_participant'] = ctx.get('participant')
        return content

    if 'imageMessage' in msg_obj:
        img = msg_obj['imageMessage']
        return {
            'type': 'image',
            'caption': img.get('caption', ''),
            'file_size': int(img.get('fileLength', 0)),
            'dimensions': f"{img.get('width', '?')}x{img.get('height', '?')}",
            'mimetype': img.get('mimetype'),
        }

    if 'videoMessage' in msg_obj:
        vid = msg_obj['videoMessage']
        return {
            'type': 'video',
            'caption': vid.get('caption', ''),
            'file_size': int(vid.get('fileLength', 0)),
            'seconds': vid.get('seconds', 0),
            'mimetype': vid.get('mimetype'),
        }

    if 'audioMessage' in msg_obj:
        aud = msg_obj['audioMessage']
        return {
            'type': 'audio',
            'seconds': aud.get('seconds', 0),
            'ptt': aud.get('ptt', False),
            'file_size': int(aud.get('fileLength', 0)),
        }

    if 'documentMessage' in msg_obj:
        doc = msg_obj['documentMessage']
        return {
            'type': 'document',
            'filename': doc.get('fileName', ''),
            'file_size': int(doc.get('fileLength', 0)),
            'mimetype': doc.get('mimetype'),
        }

    if 'reactionMessage' in msg_obj:
        react = msg_obj['reactionMessage']
        target_key = react.get('key', {})
        return {
            'type': 'reaction',
            'emoji': react.get('text', ''),
            'target_message_id': target_key.get('id'),
            'target_participant': target_key.get('participant') or target_key.get('participantAlt'),
        }

    if 'pollCreationMessage' in msg_obj or 'pollCreationMessageV3' in msg_obj:
        poll = msg_obj.get('pollCreationMessageV3') or msg_obj.get('pollCreationMessage')
        return {
            'type': 'poll',
            'question': poll.get('name', ''),
            'options': [o.get('optionName', '') for o in poll.get('options', [])],
            'selectable_count': poll.get('selectableOptionsCount', 0),
        }

    if 'pollUpdateMessage' in msg_obj:
        pu = msg_obj['pollUpdateMessage']
        creation_key = pu.get('pollCreationMessageKey', {})
        return {
            'type': 'poll_vote',
            'poll_id': creation_key.get('id', ''),
            'poll_creator': creation_key.get('participant') or creation_key.get('participantAlt', ''),
            'enc_payload': pu.get('vote', {}).get('encPayload', ''),
            'enc_iv': pu.get('vote', {}).get('encIv', ''),
        }

    if 'protocolMessage' in msg_obj:
        proto = msg_obj['protocolMessage']
        proto_type = proto.get('type', '')
        content = {'type': 'protocol', 'protocol_type': proto_type}
        if proto_type == 'GROUP_MEMBER_LABEL_CHANGE':
            label = proto.get('memberLabel', {})
            content['label'] = label.get('label', '')
        return content

    if 'locationMessage' in msg_obj:
        loc = msg_obj['locationMessage']
        return {
            'type': 'location',
            'latitude': loc.get('degreesLatitude'),
            'longitude': loc.get('degreesLongitude'),
            'name': loc.get('name', ''),
        }

    if 'contactMessage' in msg_obj:
        ct = msg_obj['contactMessage']
        return {
            'type': 'contact',
            'display_name': ct.get('displayName', ''),
        }

    return {'type': 'unknown'}


def try_decrypt_poll_vote(vote_content: dict, polls_by_id: dict) -> list[str] | None:
    """Try to decrypt a poll vote using the stored poll creation message."""
    poll_id = vote_content.get('poll_id', '')
    poll_data = polls_by_id.get(poll_id)
    if not poll_data:
        return None

    enc_payload_b64 = vote_content.get('enc_payload', '')
    enc_iv_b64 = vote_content.get('enc_iv', '')
    if not enc_payload_b64 or not enc_iv_b64:
        return None

    # load the poll creation message from store
    store_dir = os.path.join(LOGS_DIR, 'message-store')
    chat_sanitized = poll_data['chat'].replace('@', '_').replace('.', '_')
    store_file = os.path.join(store_dir, f"{chat_sanitized}_{poll_id}.json")
    if not os.path.exists(store_file):
        return None

    try:
        import base64
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        import hmac as hmac_mod

        with open(store_file) as f:
            stored_msg = json.load(f)

        ctx_info = stored_msg.get('messageContextInfo', {})
        secret_b64 = ctx_info.get('messageSecret', '')
        if not secret_b64:
            return None

        poll_enc_key = base64.b64decode(secret_b64)
        enc_payload = base64.b64decode(enc_payload_b64)
        enc_iv = base64.b64decode(enc_iv_b64)

        voter_jid = vote_content.get('_voter_jid', '')
        creator_jid = vote_content.get('poll_creator', '')

        sign = (
            poll_id.encode() +
            creator_jid.encode() +
            voter_jid.encode() +
            b'Poll Vote' +
            bytes([1])
        )

        key0 = hmac_mod.new(bytes(32), poll_enc_key, 'sha256').digest()
        dec_key = hmac_mod.new(key0, sign, 'sha256').digest()
        aad = f"{poll_id}\0{voter_jid}".encode()

        aesgcm = AESGCM(dec_key)
        decrypted = aesgcm.decrypt(enc_iv, enc_payload, aad)

        # decode protobuf PollVoteMessage - selectedOptions are SHA256 hashes
        # simple protobuf parsing: field 1 (bytes) repeated
        selected_hashes = []
        i = 0
        while i < len(decrypted):
            field_tag = decrypted[i]
            i += 1
            if (field_tag >> 3) == 1 and (field_tag & 0x7) == 2:  # field 1, length-delimited
                length = decrypted[i]
                i += 1
                selected_hashes.append(decrypted[i:i+length].hex())
                i += length
            else:
                break

        # map hashes to option names
        options = poll_data.get('options', [])
        hash_to_name = {}
        for opt in options:
            h = hashlib.sha256(opt.encode()).hexdigest()
            hash_to_name[h] = opt

        return [hash_to_name.get(h, h) for h in selected_hashes]
    except Exception:
        return None


def extract(date: str):
    users: dict[str, dict] = {}
    groups: dict[str, dict] = {}
    messages: list[dict] = []
    stickers: list[dict] = []
    receipts: list[dict] = []
    presence_log: list[dict] = []
    reactions_list: list[dict] = []
    threads: list[dict] = []
    polls_by_id: dict[str, dict] = {}
    poll_votes: list[dict] = []
    member_tags: dict[str, dict[str, str]] = defaultdict(dict)  # group_jid -> {user_jid: label}
    timeline: list[dict] = []

    def register_user(lid: str | None, phone_jid: str | None, name: str | None, group_jid: str | None = None):
        if not lid and not phone_jid:
            return
        uid = lid or phone_jid
        if uid not in users:
            users[uid] = {'lid': lid, 'phone': None, 'name': None, 'groups': set()}
        u = users[uid]
        if phone_jid and phone_jid.endswith('@s.whatsapp.net'):
            u['phone'] = f"+{phone_jid.split('@')[0]}"
        if name:
            u['name'] = name
        if group_jid:
            u['groups'].add(group_jid)

    def register_group(jid: str):
        if jid not in groups:
            groups[jid] = {'jid': jid, 'members': set(), 'message_count': 0, 'last_activity': None}

    # --- messages.upsert ---
    for entry in load_events('messages.upsert', date):
        ts = entry['timestamp']
        data = entry['data']
        msg_list = data.get('messages', [])
        msg_type = data.get('type', 'unknown')

        for msg in msg_list:
            key = msg.get('key', {})
            remote_jid = key.get('remoteJid', '')
            participant = key.get('participant')
            participant_alt = key.get('participantAlt')
            from_me = key.get('fromMe', False)
            msg_id = key.get('id', '')
            push_name = msg.get('pushName')
            msg_ts = msg.get('messageTimestamp')
            stub_type = msg.get('messageStubType')
            stub_params = msg.get('messageStubParameters', [])

            register_user(participant, participant_alt, push_name, remote_jid if remote_jid.endswith('@g.us') else None)

            if remote_jid.endswith('@g.us'):
                register_group(remote_jid)
                groups[remote_jid]['members'].add(participant or participant_alt or '')
                groups[remote_jid]['message_count'] += 1
                groups[remote_jid]['last_activity'] = ts

            msg_obj = msg.get('message', {})
            content = parse_message_content(msg_obj) if msg_obj else {'type': 'unknown'}

            if stub_type is not None:
                content = {'type': 'stub', 'stub_type': stub_type, 'stub_params': stub_params}

            parsed_ts = datetime.fromtimestamp(int(msg_ts), tz=timezone.utc).isoformat() if msg_ts else ts
            sender = participant or participant_alt

            parsed = {
                'id': msg_id,
                'timestamp': parsed_ts,
                'from': sender,
                'from_me': from_me,
                'push_name': push_name,
                'chat': remote_jid,
                'chat_type': 'group' if remote_jid.endswith('@g.us') else 'dm',
                'upsert_type': msg_type,
                'content': content,
            }
            messages.append(parsed)

            # --- collect stickers ---
            if content['type'] == 'sticker':
                stickers.append({
                    'message_id': msg_id, 'timestamp': parsed_ts,
                    'from': sender, 'push_name': push_name, 'chat': remote_jid,
                    **{k: content[k] for k in ('animated', 'ai_sticker', 'lottie', 'file_size', 'dimensions') if k in content},
                })

            # --- collect reactions from upsert ---
            if content['type'] == 'reaction':
                reactions_list.append({
                    'timestamp': parsed_ts,
                    'emoji': content['emoji'],
                    'from': sender,
                    'push_name': push_name,
                    'target_message_id': content.get('target_message_id'),
                    'target_participant': content.get('target_participant'),
                    'chat': remote_jid,
                })

            # --- collect reply threads ---
            if content.get('quoted_message_id'):
                threads.append({
                    'message_id': msg_id,
                    'timestamp': parsed_ts,
                    'from': sender,
                    'push_name': push_name,
                    'chat': remote_jid,
                    'text': content.get('text', ''),
                    'quoted_message_id': content['quoted_message_id'],
                    'quoted_participant': content.get('quoted_participant'),
                    'quoted_type': content.get('quoted_type'),
                })

            # --- collect polls ---
            if content['type'] == 'poll':
                polls_by_id[msg_id] = {
                    'id': msg_id,
                    'timestamp': parsed_ts,
                    'from': sender,
                    'push_name': push_name,
                    'chat': remote_jid,
                    'question': content['question'],
                    'options': content['options'],
                    'selectable_count': content.get('selectable_count', 0),
                    'votes': {},
                }

            # --- collect poll votes ---
            if content['type'] == 'poll_vote':
                content['_voter_jid'] = sender
                content['_voter_name'] = push_name
                poll_votes.append({
                    'timestamp': parsed_ts,
                    'voter': sender,
                    'voter_name': push_name,
                    'poll_id': content['poll_id'],
                    'chat': remote_jid,
                    'content': content,
                })

            timeline.append({
                'timestamp': parsed_ts,
                'event': 'message',
                'summary': f"[{content['type']}] {push_name or 'unknown'}: {content.get('text', content.get('type', ''))[:80]}",
            })

    # --- messages.reaction (separate event) ---
    for entry in load_events('messages.reaction', date):
        ts = entry['timestamp']
        items = entry['data'] if isinstance(entry['data'], list) else [entry['data']]
        for item in items:
            reaction = item.get('reaction', {})
            reactor_key = item.get('key', {})
            target_key = reaction.get('key', {})
            emoji = reaction.get('text', '')
            if emoji:
                reactions_list.append({
                    'timestamp': ts,
                    'emoji': emoji,
                    'from': reactor_key.get('participant'),
                    'push_name': None,
                    'target_message_id': target_key.get('id'),
                    'target_participant': target_key.get('participant') or target_key.get('participantAlt'),
                    'chat': reactor_key.get('remoteJid'),
                })

    # --- contacts.update ---
    for entry in load_events('contacts.update', date):
        contacts = entry['data']
        if not isinstance(contacts, list):
            contacts = [contacts]
        for contact in contacts:
            cid = contact.get('id', '')
            name = contact.get('notify')
            register_user(
                cid if cid.endswith('@lid') else None,
                cid if cid.endswith('@s.whatsapp.net') else None,
                name,
            )

    # --- message-receipt.update ---
    for entry in load_events('message-receipt.update', date):
        ts = entry['timestamp']
        items = entry['data'] if isinstance(entry['data'], list) else [entry['data']]
        for item in items:
            key = item.get('key', {})
            receipt = item.get('receipt', {})
            r = {
                'timestamp': ts,
                'message_id': key.get('id'),
                'chat': key.get('remoteJid'),
                'reader': receipt.get('userJid'),
                'read_at': datetime.fromtimestamp(receipt['readTimestamp'], tz=timezone.utc).isoformat() if 'readTimestamp' in receipt else None,
                'delivered_at': datetime.fromtimestamp(receipt['receiptTimestamp'], tz=timezone.utc).isoformat() if 'receiptTimestamp' in receipt else None,
            }
            receipts.append(r)

    # --- presence.update ---
    for entry in load_events('presence.update', date):
        ts = entry['timestamp']
        data = entry['data']
        chat_jid = data.get('id', '')
        for user_jid, pdata in data.get('presences', {}).items():
            presence_log.append({
                'timestamp': ts, 'chat': chat_jid,
                'user': user_jid, 'status': pdata.get('lastKnownPresence', 'unknown'),
            })

    # --- chats.update ---
    for entry in load_events('chats.update', date):
        chats_data = entry['data']
        if not isinstance(chats_data, list):
            chats_data = [chats_data]
        for chat in chats_data:
            cid = chat.get('id', '')
            if cid.endswith('@g.us'):
                register_group(cid)
                g = groups[cid]
                g['last_activity'] = entry['timestamp']
                if 'unreadCount' in chat:
                    g['unread_count'] = chat['unreadCount']

    # --- group.member-tag.update ---
    for entry in load_events('group.member-tag.update', date):
        data = entry['data']
        group_jid = data.get('groupId', '')
        participant = data.get('participant')
        participant_alt = data.get('participantAlt')
        label = data.get('label', '')
        user_jid = participant_alt or participant
        if user_jid and group_jid:
            member_tags[group_jid][user_jid] = label
        register_user(participant, participant_alt, None, group_jid)
        if group_jid.endswith('@g.us'):
            register_group(group_jid)

    # --- group metadata from cache ---
    group_cache_path = os.path.join(LOGS_DIR, 'group-metadata.json')
    group_cache = {}
    if os.path.exists(group_cache_path):
        with open(group_cache_path) as f:
            group_cache = json.load(f)

    # also load from groups.upsert / chats.upsert
    for source in ['groups.upsert', 'chats.upsert']:
        for entry in load_all_events(source):
            items = entry['data'] if isinstance(entry['data'], list) else [entry['data']]
            for item in items:
                jid = item.get('id', '')
                if jid.endswith('@g.us'):
                    if jid not in group_cache:
                        group_cache[jid] = {}
                    gc = group_cache[jid]
                    if 'subject' not in gc and item.get('subject'):
                        gc['subject'] = item['subject']
                    if 'desc' not in gc and item.get('desc'):
                        gc['desc'] = item['desc']

    # ==============================
    # BUILD OUTPUT
    # ==============================

    # --- users ---
    users_out = {}
    for uid, u in users.items():
        users_out[uid] = {**u, 'groups': sorted(u['groups'])}

    # --- groups-full.json ---
    groups_full = {}
    for gid, g in groups.items():
        cached = group_cache.get(gid, {})
        admins = [m['jid'] for m in cached.get('members', []) if m.get('admin')]
        groups_full[gid] = {
            'jid': gid,
            'name': cached.get('subject', gid.split('@')[0]),
            'description': cached.get('desc', ''),
            'owner': cached.get('owner', ''),
            'size': cached.get('size', len(g['members'])),
            'creation': cached.get('creation', 0),
            'announce': cached.get('announce', False),
            'is_community': cached.get('isCommunity', False),
            'ephemeral_duration': cached.get('ephemeralDuration', 0),
            'admins': admins,
            'active_members': sorted(g['members']),
            'active_member_count': len(g['members']),
            'message_count': g['message_count'],
            'last_activity': g['last_activity'],
            'member_tags': dict(member_tags.get(gid, {})),
        }

    # --- reactions.json ---
    reaction_by_msg: dict[str, list] = defaultdict(list)
    emoji_counts: dict[str, int] = defaultdict(int)
    reactor_counts: dict[str, int] = defaultdict(int)
    for r in reactions_list:
        mid = r.get('target_message_id')
        if mid:
            reaction_by_msg[mid].append(r)
        emoji_counts[r['emoji']] += 1
        reactor_counts[r.get('push_name') or r.get('from') or 'unknown'] += 1

    reactions_out = {
        'reactions': reactions_list,
        'by_message': {mid: rs for mid, rs in reaction_by_msg.items()},
        'top_emojis': dict(sorted(emoji_counts.items(), key=lambda x: -x[1])[:20]),
        'top_reactors': dict(sorted(reactor_counts.items(), key=lambda x: -x[1])[:20]),
        'total': len(reactions_list),
    }

    # --- threads.json ---
    reply_to_counts: dict[str, int] = defaultdict(int)
    quoted_msg_counts: dict[str, int] = defaultdict(int)
    for t in threads:
        quoted_p = t.get('quoted_participant', '')
        if quoted_p:
            reply_to_counts[quoted_p] += 1
        quoted_msg_counts[t['quoted_message_id']] += 1

    threads_out = {
        'replies': threads,
        'total_replies': len(threads),
        'most_quoted_messages': dict(sorted(quoted_msg_counts.items(), key=lambda x: -x[1])[:20]),
        'most_replied_to_users': dict(sorted(reply_to_counts.items(), key=lambda x: -x[1])[:20]),
    }

    # --- polls.json (with decrypted votes) ---
    for vote in poll_votes:
        content = vote['content']
        poll_id = content['poll_id']
        if poll_id not in polls_by_id:
            continue
        decrypted = try_decrypt_poll_vote(content, polls_by_id)
        voter_name = vote['voter_name'] or vote['voter']
        voter_jid = vote['voter']

        poll = polls_by_id[poll_id]
        poll['votes'][voter_jid] = {
            'name': voter_name,
            'selected': decrypted if decrypted is not None else [],
            'decrypted': decrypted is not None,
            'timestamp': vote['timestamp'],
        }

    polls_out = []
    for poll in polls_by_id.values():
        # compute aggregated results
        option_counts = {opt: [] for opt in poll['options']}
        for voter_jid, vote_data in poll['votes'].items():
            for selected in vote_data.get('selected', []):
                if selected in option_counts:
                    option_counts[selected].append(vote_data['name'])

        polls_out.append({
            **{k: v for k, v in poll.items() if k != 'votes'},
            'results': {opt: {'count': len(voters), 'voters': voters} for opt, voters in option_counts.items()},
            'total_voters': len(poll['votes']),
            'votes_log': list(poll['votes'].values()),
        })

    # --- member-profiles.json ---
    msg_count_by_user: dict[str, int] = defaultdict(int)
    msg_count_by_user_group: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    media_by_user: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    first_msg_ts: dict[str, str] = {}
    last_msg_ts: dict[str, str] = {}
    for m in messages:
        uid = m['from']
        if not uid:
            continue
        msg_count_by_user[uid] += 1
        if m['chat_type'] == 'group':
            msg_count_by_user_group[uid][m['chat']] += 1
        media_by_user[uid][m['content']['type']] += 1
        if uid not in first_msg_ts:
            first_msg_ts[uid] = m['timestamp']
        last_msg_ts[uid] = m['timestamp']

    member_profiles = {}
    for uid, u in users.items():
        all_tags = {}
        admin_in = []
        for gid in u['groups']:
            tag = member_tags.get(gid, {}).get(uid)
            if tag:
                all_tags[gid] = tag
            cached = group_cache.get(gid, {})
            for member in cached.get('members', []):
                if member.get('jid') == uid and member.get('admin'):
                    admin_in.append(gid)

        member_profiles[uid] = {
            'lid': u['lid'],
            'phone': u['phone'],
            'name': u['name'],
            'groups': sorted(u['groups']),
            'group_tags': all_tags,
            'admin_in': admin_in,
            'total_messages': msg_count_by_user.get(uid, 0),
            'messages_by_group': dict(msg_count_by_user_group.get(uid, {})),
            'messages_by_type': dict(media_by_user.get(uid, {})),
            'first_seen': first_msg_ts.get(uid),
            'last_seen': last_msg_ts.get(uid),
            'composing_events': sum(1 for p in presence_log if p['user'] == uid and p['status'] == 'composing'),
        }

    # --- activity.json ---
    msgs_by_hour: dict[int, int] = defaultdict(int)
    msgs_by_group_hour: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    media_breakdown: dict[str, int] = defaultdict(int)
    conversation_starters: dict[str, int] = defaultdict(int)

    last_msg_time_by_chat: dict[str, datetime] = {}
    for m in messages:
        try:
            ts = datetime.fromisoformat(m['timestamp'])
        except Exception:
            continue
        msgs_by_hour[ts.hour] += 1
        if m['chat_type'] == 'group':
            msgs_by_group_hour[m['chat']][ts.hour] += 1
        media_breakdown[m['content']['type']] += 1

        # conversation starter = first msg in chat after 30min gap
        chat = m['chat']
        if chat in last_msg_time_by_chat:
            gap = (ts - last_msg_time_by_chat[chat]).total_seconds()
            if gap > 1800:
                name = m.get('push_name') or m.get('from') or 'unknown'
                conversation_starters[name] += 1
        else:
            name = m.get('push_name') or m.get('from') or 'unknown'
            conversation_starters[name] += 1
        last_msg_time_by_chat[chat] = ts

    activity_out = {
        'messages_by_hour': {str(h): msgs_by_hour.get(h, 0) for h in range(24)},
        'messages_by_group_hour': {
            gid: {str(h): counts.get(h, 0) for h in range(24)}
            for gid, counts in msgs_by_group_hour.items()
        },
        'media_breakdown': dict(sorted(media_breakdown.items(), key=lambda x: -x[1])),
        'conversation_starters': dict(sorted(conversation_starters.items(), key=lambda x: -x[1])[:20]),
        'total_composing_events': sum(1 for p in presence_log if p['status'] == 'composing'),
        'unique_typers': len({p['user'] for p in presence_log if p['status'] == 'composing'}),
    }

    # --- stats ---
    msg_by_user = defaultdict(int)
    msg_by_type = defaultdict(int)
    msg_by_group = defaultdict(int)
    for m in messages:
        msg_by_user[m.get('push_name') or m.get('from') or 'unknown'] += 1
        msg_by_type[m['content']['type']] += 1
        if m['chat_type'] == 'group':
            msg_by_group[m['chat']] += 1

    stats = {
        'date': date,
        'total_messages': len(messages),
        'total_users': len(users_out),
        'total_groups': len(groups_full),
        'total_stickers': len(stickers),
        'total_receipts': len(receipts),
        'total_reactions': len(reactions_list),
        'total_replies': len(threads),
        'total_polls': len(polls_out),
        'total_poll_votes': len(poll_votes),
        'total_presence_events': len(presence_log),
        'total_timeline_events': len(timeline),
        'messages_by_user': dict(sorted(msg_by_user.items(), key=lambda x: -x[1])),
        'messages_by_type': dict(sorted(msg_by_type.items(), key=lambda x: -x[1])),
        'messages_by_group': dict(sorted(msg_by_group.items(), key=lambda x: -x[1])),
    }

    # --- write output ---
    timeline.sort(key=lambda x: x['timestamp'])
    out_dir = os.path.join(OUTPUT_DIR, date)
    os.makedirs(out_dir, exist_ok=True)

    outputs = {
        'users.json': users_out,
        'groups-full.json': groups_full,
        'messages.json': messages,
        'stickers.json': stickers,
        'receipts.json': receipts,
        'presence.json': presence_log,
        'reactions.json': reactions_out,
        'threads.json': threads_out,
        'polls.json': polls_out,
        'member-profiles.json': member_profiles,
        'activity.json': activity_out,
        'timeline.json': timeline,
        'stats.json': stats,
    }

    for filename, data in outputs.items():
        path = os.path.join(out_dir, filename)
        with open(path, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        count = len(data) if isinstance(data, (list, dict)) else 0
        print(f'  {filename:25s} → {count:>5} entries')

    print(f'\n📊 Summary:')
    print(f'  Messages:  {stats["total_messages"]:>5}   Reactions: {stats["total_reactions"]:>5}')
    print(f'  Users:     {stats["total_users"]:>5}   Replies:   {stats["total_replies"]:>5}')
    print(f'  Groups:    {stats["total_groups"]:>5}   Polls:     {stats["total_polls"]:>5} ({stats["total_poll_votes"]} votes)')
    print(f'  Stickers:  {stats["total_stickers"]:>5}   Receipts:  {stats["total_receipts"]:>5}')

    top_users = list(stats['messages_by_user'].items())[:5]
    if top_users:
        print(f'\n🏆 Top senders:')
        for name, count in top_users:
            bar = '█' * min(count, 30)
            print(f'  {count:>3}x {bar} {name}')

    top_emojis = list(reactions_out['top_emojis'].items())[:5]
    if top_emojis:
        print(f'\n😀 Top reactions:')
        for emoji, count in top_emojis:
            print(f'  {count:>3}x {emoji}')

    if polls_out:
        print(f'\n📊 Polls:')
        for poll in polls_out:
            print(f'  "{poll["question"]}" — {poll["total_voters"]} voters')
            for opt, result in poll['results'].items():
                bar = '█' * min(result['count'], 20)
                print(f'    {result["count"]:>2} {bar} {opt}')

    starters = list(activity_out['conversation_starters'].items())[:5]
    if starters:
        print(f'\n💬 Conversation starters:')
        for name, count in starters:
            print(f'  {count:>3}x {name}')

    print(f'\n📁 Output: {out_dir}/')


if __name__ == '__main__':
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime('%Y-%m-%d')
    print(f'Extracting data for {date}...\n')
    extract(date)

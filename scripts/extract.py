#!/usr/bin/env python3
"""
Extracts structured data from Baileys raw event logs.

Reads logs/<event>/<date>.json and produces extracted/<date>/ with:
  - users.json          — all known users (id, phone, name, groups)
  - groups.json         — group metadata and member lists
  - messages.json       — all messages with parsed content
  - stickers.json       — sticker metadata
  - receipts.json       — read/delivery receipts
  - presence.json       — typing/online indicators
  - timeline.json       — unified chronological feed of all events
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

LOGS_DIR = os.path.join(os.path.dirname(__file__), '..', 'logs')
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'extracted')


def load_events(event_name: str, date: str) -> list:
    path = os.path.join(LOGS_DIR, event_name, f'{date}.json')
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return json.load(f)


def resolve_jid(jid: str | None) -> dict:
    if not jid:
        return {}
    if jid.endswith('@s.whatsapp.net'):
        phone = jid.split('@')[0]
        return {'jid': jid, 'type': 'phone', 'phone': f'+{phone}'}
    if jid.endswith('@g.us'):
        return {'jid': jid, 'type': 'group'}
    if jid.endswith('@lid'):
        return {'jid': jid, 'type': 'lid'}
    if jid.endswith('@broadcast'):
        return {'jid': jid, 'type': 'broadcast'}
    if jid.endswith('@newsletter'):
        return {'jid': jid, 'type': 'newsletter'}
    return {'jid': jid, 'type': 'unknown'}


def parse_message_content(msg_obj: dict) -> dict:
    """Extract the actual content from a message object."""
    content = {'type': 'unknown'}

    if not msg_obj:
        return content

    if 'conversation' in msg_obj:
        content = {'type': 'text', 'text': msg_obj['conversation']}

    elif 'extendedTextMessage' in msg_obj:
        ext = msg_obj['extendedTextMessage']
        content = {'type': 'text', 'text': ext.get('text', '')}
        if 'contextInfo' in ext:
            ctx = ext['contextInfo']
            if 'quotedMessage' in ctx:
                content['quoted_message_id'] = ctx.get('stanzaId')
                content['quoted_participant'] = ctx.get('participant')

    elif 'stickerMessage' in msg_obj:
        stk = msg_obj['stickerMessage']
        content = {
            'type': 'sticker',
            'mimetype': stk.get('mimetype'),
            'animated': stk.get('isAnimated', False),
            'ai_sticker': stk.get('isAiSticker', False),
            'lottie': stk.get('isLottie', False),
            'file_size': int(stk.get('fileLength', 0)),
            'width': stk.get('width', 0),
            'height': stk.get('height', 0),
            'url': stk.get('url'),
            'direct_path': stk.get('directPath'),
            'media_key': stk.get('mediaKey'),
        }
        if 'contextInfo' in stk:
            ctx = stk['contextInfo']
            if 'quotedMessage' in ctx:
                content['quoted_message_id'] = ctx.get('stanzaId')
                content['quoted_participant'] = ctx.get('participant')

    elif 'imageMessage' in msg_obj:
        img = msg_obj['imageMessage']
        content = {
            'type': 'image',
            'mimetype': img.get('mimetype'),
            'caption': img.get('caption', ''),
            'file_size': int(img.get('fileLength', 0)),
            'width': img.get('width', 0),
            'height': img.get('height', 0),
            'url': img.get('url'),
        }

    elif 'videoMessage' in msg_obj:
        vid = msg_obj['videoMessage']
        content = {
            'type': 'video',
            'mimetype': vid.get('mimetype'),
            'caption': vid.get('caption', ''),
            'file_size': int(vid.get('fileLength', 0)),
            'seconds': vid.get('seconds', 0),
            'url': vid.get('url'),
        }

    elif 'audioMessage' in msg_obj:
        aud = msg_obj['audioMessage']
        content = {
            'type': 'audio',
            'mimetype': aud.get('mimetype'),
            'seconds': aud.get('seconds', 0),
            'ptt': aud.get('ptt', False),
            'file_size': int(aud.get('fileLength', 0)),
            'url': aud.get('url'),
        }

    elif 'documentMessage' in msg_obj:
        doc = msg_obj['documentMessage']
        content = {
            'type': 'document',
            'mimetype': doc.get('mimetype'),
            'filename': doc.get('fileName', ''),
            'file_size': int(doc.get('fileLength', 0)),
            'url': doc.get('url'),
        }

    elif 'protocolMessage' in msg_obj:
        proto = msg_obj['protocolMessage']
        proto_type = proto.get('type', '')
        content = {'type': 'protocol', 'protocol_type': proto_type}
        if proto_type == 'GROUP_MEMBER_LABEL_CHANGE':
            label = proto.get('memberLabel', {})
            content['label'] = label.get('label', '')

    elif 'reactionMessage' in msg_obj:
        react = msg_obj['reactionMessage']
        content = {
            'type': 'reaction',
            'emoji': react.get('text', ''),
            'target_message_id': react.get('key', {}).get('id'),
        }

    elif 'pollCreationMessage' in msg_obj:
        poll = msg_obj['pollCreationMessage']
        content = {
            'type': 'poll',
            'name': poll.get('name', ''),
            'options': [o.get('optionName', '') for o in poll.get('options', [])],
        }

    elif 'locationMessage' in msg_obj:
        loc = msg_obj['locationMessage']
        content = {
            'type': 'location',
            'latitude': loc.get('degreesLatitude'),
            'longitude': loc.get('degreesLongitude'),
            'name': loc.get('name', ''),
        }

    elif 'contactMessage' in msg_obj:
        ct = msg_obj['contactMessage']
        content = {
            'type': 'contact',
            'display_name': ct.get('displayName', ''),
            'vcard': ct.get('vcard', ''),
        }

    # stub messages (failed decrypt, system notifications, etc)
    return content


def extract(date: str):
    users: dict[str, dict] = {}
    groups: dict[str, dict] = {}
    messages: list[dict] = []
    stickers: list[dict] = []
    receipts: list[dict] = []
    presence_log: list[dict] = []
    timeline: list[dict] = []

    def register_user(lid: str | None, phone_jid: str | None, name: str | None, group_jid: str | None = None):
        if not lid and not phone_jid:
            return
        uid = lid or phone_jid
        if uid not in users:
            users[uid] = {
                'lid': lid,
                'phone': None,
                'name': None,
                'groups': set(),
            }
        u = users[uid]
        if phone_jid and phone_jid.endswith('@s.whatsapp.net'):
            u['phone'] = f"+{phone_jid.split('@')[0]}"
        if name:
            u['name'] = name
        if group_jid:
            u['groups'].add(group_jid)

    def register_group(jid: str):
        if jid not in groups:
            groups[jid] = {
                'jid': jid,
                'members': set(),
                'message_count': 0,
                'last_activity': None,
            }

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

            # register user
            register_user(participant, participant_alt, push_name, remote_jid if remote_jid.endswith('@g.us') else None)

            # register group
            if remote_jid.endswith('@g.us'):
                register_group(remote_jid)
                groups[remote_jid]['members'].add(participant or participant_alt or '')
                groups[remote_jid]['message_count'] += 1
                groups[remote_jid]['last_activity'] = ts

            # parse content
            msg_obj = msg.get('message', {})
            content = parse_message_content(msg_obj) if msg_obj else {'type': 'unknown'}

            # stub messages (decrypt failures, system events)
            if stub_type is not None:
                content = {
                    'type': 'stub',
                    'stub_type': stub_type,
                    'stub_params': stub_params,
                }

            parsed = {
                'id': msg_id,
                'timestamp': datetime.fromtimestamp(int(msg_ts), tz=timezone.utc).isoformat() if msg_ts else ts,
                'from': participant or participant_alt,
                'from_me': from_me,
                'push_name': push_name,
                'chat': remote_jid,
                'chat_type': 'group' if remote_jid.endswith('@g.us') else 'dm',
                'upsert_type': msg_type,
                'content': content,
            }
            messages.append(parsed)

            if content['type'] == 'sticker':
                stickers.append({
                    'message_id': msg_id,
                    'timestamp': parsed['timestamp'],
                    'from': parsed['from'],
                    'push_name': push_name,
                    'chat': remote_jid,
                    'animated': content.get('animated', False),
                    'ai_sticker': content.get('ai_sticker', False),
                    'lottie': content.get('lottie', False),
                    'file_size': content.get('file_size', 0),
                    'dimensions': f"{content.get('width', '?')}x{content.get('height', '?')}",
                    'url': content.get('url'),
                    'direct_path': content.get('direct_path'),
                })

            timeline.append({
                'timestamp': parsed['timestamp'],
                'event': 'message',
                'summary': f"[{content['type']}] {push_name or 'unknown'}: {content.get('text', content.get('type', ''))[:80]}",
                'data': parsed,
            })

    # --- contacts.update ---
    for entry in load_events('contacts.update', date):
        ts = entry['timestamp']
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
        items = entry['data']
        if not isinstance(items, list):
            items = [items]
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
            timeline.append({
                'timestamp': ts,
                'event': 'receipt',
                'summary': f"{'read' if r['read_at'] else 'delivered'} by {r['reader']}",
                'data': r,
            })

    # --- presence.update ---
    for entry in load_events('presence.update', date):
        ts = entry['timestamp']
        data = entry['data']
        chat_jid = data.get('id', '')
        presences = data.get('presences', {})
        for user_jid, pdata in presences.items():
            status = pdata.get('lastKnownPresence', 'unknown')
            p = {
                'timestamp': ts,
                'chat': chat_jid,
                'user': user_jid,
                'status': status,
            }
            presence_log.append(p)
            timeline.append({
                'timestamp': ts,
                'event': 'presence',
                'summary': f"{user_jid} is {status} in {chat_jid}",
                'data': p,
            })

    # --- chats.update ---
    for entry in load_events('chats.update', date):
        ts = entry['timestamp']
        chats = entry['data']
        if not isinstance(chats, list):
            chats = [chats]
        for chat in chats:
            cid = chat.get('id', '')
            if cid.endswith('@g.us'):
                register_group(cid)
                g = groups[cid]
                g['last_activity'] = ts
                if 'unreadCount' in chat:
                    g['unread_count'] = chat['unreadCount']
                if 'conversationTimestamp' in chat:
                    g['conversation_timestamp'] = chat['conversationTimestamp']

    # --- group.member-tag.update ---
    for entry in load_events('group.member-tag.update', date):
        ts = entry['timestamp']
        data = entry['data']
        group_jid = data.get('groupId', '')
        participant = data.get('participant')
        participant_alt = data.get('participantAlt')
        label = data.get('label', '')

        register_user(participant, participant_alt, None, group_jid)
        if group_jid.endswith('@g.us'):
            register_group(group_jid)

        timeline.append({
            'timestamp': ts,
            'event': 'group_member_tag',
            'summary': f"{participant_alt or participant} tagged as '{label}' in {group_jid}",
            'data': data,
        })

    # --- connection.update ---
    for entry in load_events('connection.update', date):
        ts = entry['timestamp']
        data = entry['data']
        timeline.append({
            'timestamp': ts,
            'event': 'connection',
            'summary': f"connection: {json.dumps(data)}",
            'data': data,
        })

    # --- serialize ---
    timeline.sort(key=lambda x: x['timestamp'])

    # convert sets to lists for JSON
    users_out = {}
    for uid, u in users.items():
        users_out[uid] = {**u, 'groups': sorted(u['groups'])}

    groups_out = {}
    for gid, g in groups.items():
        groups_out[gid] = {
            **g,
            'members': sorted(g['members']),
            'member_count': len(g['members']),
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
        'total_groups': len(groups_out),
        'total_stickers': len(stickers),
        'total_receipts': len(receipts),
        'total_presence_events': len(presence_log),
        'total_timeline_events': len(timeline),
        'messages_by_user': dict(sorted(msg_by_user.items(), key=lambda x: -x[1])),
        'messages_by_type': dict(sorted(msg_by_type.items(), key=lambda x: -x[1])),
        'messages_by_group': dict(sorted(msg_by_group.items(), key=lambda x: -x[1])),
    }

    # --- write output ---
    out_dir = os.path.join(OUTPUT_DIR, date)
    os.makedirs(out_dir, exist_ok=True)

    outputs = {
        'users.json': users_out,
        'groups.json': groups_out,
        'messages.json': messages,
        'stickers.json': stickers,
        'receipts.json': receipts,
        'presence.json': presence_log,
        'timeline.json': timeline,
        'stats.json': stats,
    }

    for filename, data in outputs.items():
        path = os.path.join(out_dir, filename)
        with open(path, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False, default=str)
        count = len(data) if isinstance(data, (list, dict)) else 0
        print(f'  {filename:20s} → {count:>4} entries')

    print(f'\n📊 Stats:')
    print(f'  Messages: {stats["total_messages"]}')
    print(f'  Users:    {stats["total_users"]}')
    print(f'  Groups:   {stats["total_groups"]}')
    print(f'  Stickers: {stats["total_stickers"]}')
    print(f'  Receipts: {stats["total_receipts"]}')

    top_users = list(stats['messages_by_user'].items())[:5]
    if top_users:
        print(f'\n🏆 Top senders:')
        for name, count in top_users:
            print(f'  {count:>3}x  {name}')

    print(f'\n📁 Output: {out_dir}/')


if __name__ == '__main__':
    date = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime('%Y-%m-%d')
    print(f'Extracting data for {date}...\n')
    extract(date)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, parseLinks, fromFx, fromVx, pickFormats } from '../js/resolve.js';

test('parses the link shapes X hands out', () => {
  const cases = [
    ['https://x.com/someone/status/1585341984679469056', '1585341984679469056', 1, 'someone'],
    ['https://x.com/someone/status/1585341984679469056?s=46&t=abc', '1585341984679469056', 1, 'someone'],
    ['https://twitter.com/a_b/status/123456789/video/2', '123456789', 2, 'a_b'],
    ['https://mobile.x.com/i/status/987654321', '987654321', 1, null],
    ['https://fxtwitter.com/u/status/55555555', '55555555', 1, 'u'],
    ['x.com/u/status/1234567', '1234567', 1, 'u'],
    ['1585341984679469056', '1585341984679469056', 1, null],
  ];
  for (const [input, id, index, user] of cases) {
    const r = parseLink(input);
    assert.ok(r, input);
    assert.equal(r.id, id);
    assert.equal(r.index, index);
    assert.equal(r.user, user);
  }
  assert.equal(parseLink('https://box.com/u/status/1234567'), null);
  assert.equal(parseLink('hello'), null);
});

test('pulls several links out of pasted text', () => {
  const refs = parseLinks('look https://x.com/a/status/111111 and https://x.com/b/status/222222 https://x.com/a/status/111111');
  assert.deepEqual(
    refs.map((r) => r.id),
    ['111111', '222222'],
  );
});

const fx = {
  code: 200,
  tweet: {
    url: 'https://x.com/someone/status/1585341984679469056',
    id: '1585341984679469056',
    text: 'clip',
    author: { screen_name: 'someone', name: 'Some One' },
    media: {
      all: [
        { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' },
        {
          type: 'video',
          url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1920x1080/big.mp4?tag=14',
          thumbnail_url: 'https://pbs.twimg.com/thumb.jpg',
          duration: 9.301,
          width: 1920,
          height: 1080,
          formats: [
            { url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/list.m3u8?tag=14', container: 'm3u8' },
            { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/480x270/a.mp4?tag=14', bitrate: 256000, container: 'mp4' },
            { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/b.mp4?tag=14', bitrate: 832000, container: 'mp4' },
            { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/c.mp4?tag=14', bitrate: 2176000, container: 'mp4' },
            { url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1920x1080/d.mp4?tag=14', bitrate: 10368000, container: 'mp4' },
          ],
        },
      ],
    },
  },
};

test('reads fxtwitter videos and picks play and prep files', () => {
  const info = fromFx(fx);
  assert.equal(info.author, 'someone');
  assert.equal(info.videos.length, 1);
  const v = info.videos[0];
  assert.equal(v.formats.length, 4);
  const f = pickFormats(v);
  assert.match(f.play, /1920x1080\/d\.mp4/);
  assert.match(f.prep, /640x360\/b\.mp4/);
});

test('falls back to the quoted post when the main one has no video', () => {
  const quoted = { tweet: { id: '1', url: 'u', author: { screen_name: 'a' }, media: { all: [] }, quote: fx.tweet } };
  const info = fromFx(quoted);
  assert.equal(info.videos.length, 1);
  assert.equal(info.author, 'someone');
});

test('reads vxtwitter videos', () => {
  const info = fromVx({
    tweetID: '9',
    tweetURL: 'https://twitter.com/a/status/9',
    user_screen_name: 'a',
    text: 't',
    media_extended: [
      { type: 'video', url: 'https://video.twimg.com/x/vid/720x1280/v.mp4', size: { width: 720, height: 1280 }, duration_millis: 12000, thumbnail_url: 'th' },
    ],
  });
  assert.equal(info.videos[0].duration, 12);
  const f = pickFormats(info.videos[0]);
  assert.equal(f.play, f.prep);
});

# Depthwalk

Watch X videos life size in VR on a Meta Quest.

Depthwalk is a web page you open in the Quest browser. Paste a link to an X post with a video and it plays on a big screen in front of you, sized so the scene appears at about real size. The video keeps its exact shape with nothing stretched, and its colours softly light up the dark around it.

Open it at **https://yt2corgi.github.io/depthwalk/**

## How to use it

1. On X tap **Share** then **Copy link** on a video post
2. In Depthwalk tap **Paste** (or paste into the box)
3. Tap **Enter VR**

Paste several links to queue them and flick the left stick to move between them.

## Controls in VR

| Button | Does |
| --- | --- |
| Trigger | Play or pause |
| Grip | Recenter the screen in front of you |
| Right stick sideways | Scrub |
| Right stick up and down | Screen size |
| Left stick sideways | Next or last clip |
| A | Speed 1x 0.5x 0.25x |
| B or Y | Show the control bar near your left hand |

## How it works

- The video file comes straight from X through the public [fxtwitter](https://github.com/FixTweet/FxTwitter) API with [vxtwitter](https://github.com/dylanpdx/BetterTwitFix) as a fallback
- [three.js](https://threejs.org) draws the screen in WebXR at the angle a phone camera sees, so people come out about life size
- Sound comes from the screen's position
- Clips you open are kept in the browser so they reopen instantly

## Run it locally

```
npm run serve
npm test
```

Run `npm run stamp` before publishing so browsers pick up the new files.

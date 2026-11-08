# Depthwalk

Watch X videos in 180 degree 3D on a Meta Quest.

Depthwalk is a web page you open in the Quest browser. Paste a link to an X post with a video and it adds 3D depth right on the headset, then wraps the clip 180 degrees around you so people pop out of the background like a 3D movie. The scene moves with your head so you never see the gaps behind people.

Open it at **https://yt2corgi.github.io/depthwalk/**

## How to use it

1. On X tap **Share** then **Copy link** on a video post
2. In Depthwalk tap **Paste** (or paste into the box)
3. Wait for the 3D to finish. It's capped at about 30 seconds, and the first time also downloads the 3D AI (about 19 MB) which the browser keeps afterwards
4. Tap **Enter VR**

Paste several links to queue them. The next one gets its 3D while you watch.

## Controls in VR

| Button | Does |
| --- | --- |
| Trigger | Play or pause |
| Grip | Recenter in front of you |
| Right stick sideways | Scrub |
| Right stick up and down | 3D amount |
| Left stick sideways | Next or last clip |
| Left stick up and down | Size |
| A | Speed 1x 0.5x 0.25x |
| B or Y | Control bar with the 180 or real size switch |

## How it works

- The video file comes straight from X through the public [fxtwitter](https://github.com/FixTweet/FxTwitter) API with [vxtwitter](https://github.com/dylanpdx/BetterTwitFix) as a fallback
- [Depth Anything V2 Small](https://huggingface.co/onnx-community/depth-anything-v2-small) runs in the browser through [Transformers.js](https://github.com/huggingface/transformers.js) on WebGPU. It builds depth coarse to fine across the clip within a time budget and aligns frames so the depth doesn't flicker
- [three.js](https://threejs.org) turns each depth frame into a mesh wrapped 180 degrees around you, blends between depth frames and lets the video colours glow into the dark around it
- Clips you open are kept in the browser with their 3D so they reopen instantly

Nothing is uploaded anywhere. All the processing happens on the headset.

## Run it locally

```
npm run serve
npm test
```

Run `npm run stamp` before publishing so browsers pick up the new files.

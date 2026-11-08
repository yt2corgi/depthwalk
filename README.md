# Depthwalk

Stand inside X videos in VR on a Meta Quest.

Depthwalk is a web page you open in the Quest browser. Paste a link to an X post with a video and it builds a depth map for every moment of the clip right on the headset, then drops you into the scene life size. You can walk up to people, lean around them and freeze any moment to walk around it.

Open it at **https://yt2corgi.github.io/depthwalk/**

## How to use it

1. On X tap **Share** then **Copy link** on a video post
2. In Depthwalk tap **Paste** (or paste into the box)
3. Wait for the depth to build. The first time also downloads the depth AI (about 72 MB) which the browser keeps afterwards
4. Tap **Enter VR**

Paste several links to queue them. The next one builds while you watch.

## Controls in VR

| Button | Does |
| --- | --- |
| Trigger | Play or freeze |
| Grip | Recenter the scene where you stand |
| Right stick sideways | Scrub |
| Right stick up and down | Depth strength |
| Left stick sideways | Next or last clip |
| Left stick up and down | World size |
| A | Speed 1x 0.5x 0.25x |
| B or Y | Show the control bar near your left hand |

## How it works

- The video file comes straight from X through the public [fxtwitter](https://github.com/FixTweet/FxTwitter) API with [vxtwitter](https://github.com/dylanpdx/BetterTwitFix) as a fallback
- [Depth Anything V2 Base](https://huggingface.co/onnx-community/depth-anything-v2-base) runs in the browser through [Transformers.js](https://github.com/huggingface/transformers.js) on WebGPU, about 10 depth frames per second of video, aligned frame to frame so the depth doesn't flicker
- [three.js](https://threejs.org) turns each depth frame into a mesh you can walk around, blends between depth frames, softly fills the gaps behind people and lets the video colours bleed past the frame edges
- Clips you open are kept in the browser with their depth so they reopen instantly

Nothing is uploaded anywhere. All the processing happens on the headset.

## Run it locally

```
npm run serve
npm test
```

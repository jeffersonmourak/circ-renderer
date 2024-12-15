# Circ-renderer

It's a simple tool to render a Logisim Circ file and simulate some of its components

> **Note:** This project is still in development, so it may not work as expected.

## Installation

You can use any of your preferred node package manager to install this package.

```bash
npm install circ-renderer
```

## Usage

```typescript
import { CircRenderer } from 'circ-renderer';

// ...

const file = await fetch('./file.circ');
const fileContent = await file.text();

const options = // optional

const canvasElement = new CircRenderer(fileContent, options);

document.body.appendChild(canvasElement);
```

## Options

<!-- table of options with key, required, default, description -->

| Name | Required | Default | Description |
| ---- | -------- | ------- | ----------- |
| `width` | No | 800 | The width of the canvas |
| `height` | No | 600 | The height of the canvas |
| `scale` | No | 1 | The scale of the canvas |
| `theme` | No | - | Color Scheme and skin instructions |

## Theming and Skins

Theming and skins are still in very early development, the idea is to provide a way to customize the look of the components and the canvas.
platform independent, so you can have multple themes and skins for the same circuit.

### Theme Object

```typescript
const theme: CircTheme = {
  colors: // color scheme
  library: // skin instructions
}
```

### Color Scheme

The color scheme is a simple object that contains the colors for the components and the canvas.

```typescript
// Default color scheme
const colors = {
 primary: "#007bff",
 primary1: "#007bff",
 primary2: "#0056b3",
 backgroundPrimary: "#f8f9fa",
 backgroundPrimaryAlt: "#f8f9fa",
 backgroundSecondary: "#f8f9fa",
 red: "#dc3545",
 orange: "#fd7e14",
 yellow: "#ffc107",
 green: "#28a745",
 cyan: "#17a2b8",
 blue: "#007bff",
 purple: "#6f42c1",
 pink: "#e83e8c", // <- used as base color all default skins
 // These base?? means nothing. possibly will be removed in the future
 base00: "#ffffff",
 base05: "#f8f9fa",
 base10: "#f1f3f5",
 base20: "#e9ecef",
 base25: "#dee2e6",
 base30: "#ced4da",
 base35: "#adb5bd",
 base40: "#868e96",
 base50: "#495057",
 base60: "#343a40",
 base70: "#212529",
 base100: "#000000",
};
```

### Skin Instructions

The skin instructions are simple functions that recives a set of parameters and renders the draw instructions of the component in the canvas.

> This is still in development, so the API may change in the future. i'm experimenting with different ways to implement this, but the idea is to have enable the skin maker to draw instructions like a 0,0 canvas position and rotation independend.

> **Note:** The Skin does not render the component ports, this is done by the renderer.

```typescript
import {
  type AndState, // params from the file.
  type DrawArguments, // arguments used for rendering in canvas, theme information, assets, and component location information.
  resolveCn, // <- helper function to resolve a circuit number to a canvas number (scale factor)
} from "circ-renderer";
// Example of a skin instruction
const AndSkin = ({
  bounds,
  ctx,
  theme,
  scaleFactor = 1,
  state,
  faceAngles,
  face,
  assets,
}: DrawArguments<AndState>) => {
  ctx.save(); // <- Important to not mess with the canvas state.
  const [loc, dim] = bounds;

  const [ogX, ogY] = loc;
  const [width, height] = dim;

  const angle = faceAngles[toFaceIndex(face)] + 90;

  const rad = (angle * Math.PI) / 180;

  ctx.translate(
    resolveCn(ogX, scaleFactor) + resolveCn(width, scaleFactor) / 2,
    resolveCn(ogY, scaleFactor) + resolveCn(height, scaleFactor) / 2
  );

  ctx.rotate(rad);

  const w = resolveCn(width, scaleFactor);
  const h = resolveCn(height, scaleFactor);

  ctx.drawImage(assets.AND, w / -2, h / -2, w, h); // <- using an asset to render the component [try not to use, read more below]
  ctx.rotate(-rad);

  ctx.beginPath();
  ctx.font = `${6 * scaleFactor}px monospace`;

  ctx.fillStyle = theme.colors.base00; // <- using the base as text color this is *NOT* a standard.
  ctx.strokeStyle = theme.colors.base70;
  ctx.lineWidth = 0.5 * scaleFactor;
  ctx.textAlign = "center";
  ctx.fill();

  ctx.strokeText("AND", 0, 2 * scaleFactor);

  ctx.fillText("AND", 0, 2 * scaleFactor);

  ctx.restore(); // Important to restore unless you want a labirinthtic canvas or psychedelic circuit, which is cool too. but not the goal.
};
```

### Assets

The assets is an experiment to provide a way to render the components with images, this is not the best way to do, but it's a way to do it and I WILL CHANGE IT IN THE NEAR FUTURE.

```typescript
export const prepareTheme = async (): Promise<CircTheme> => {
  const assets = await loadAsset();

  return {
    colors,
    library: {
      LED: (drawArgs) => LEDSkin({ ...drawArgs, assets }),
      NOT: (drawArgs) => NotSkin({ ...drawArgs, assets }),
      pin: (drawArgs) => PinSkin({ ...drawArgs, assets }),
      wire: (drawArgs) => WireSkin({ ...drawArgs, assets }),
      AND: (drawArgs) => AndSkin({ ...drawArgs, assets }),
      NAND: (drawArgs) => NandSkin({ ...drawArgs, assets }),
      OR: (drawArgs) => OrSkin({ ...drawArgs, assets }),
      XOR: (drawArgs) => XorSkin({ ...drawArgs, assets }),
    },
  };
};
```

load the assets in the way you like and then overload the skin functions from your theme to use the assets.

my plan is to provide a nice API to render the components with much of hassle and boilerplate. but for now, this is the way to do it.

## Example

[![Screen Recording 2024-12-15 at 9 56 35 AM](https://github.com/user-attachments/assets/6ae10d7f-2220-4de2-86db-4a5747b8744b)](https://jeffersonmourak.com/blog/the-binary)

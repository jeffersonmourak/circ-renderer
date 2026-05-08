const supportedPathDrawingStyles = [
  "lineCap",
  "lineDashOffset",
  "lineJoin",
  "lineWidth",
  "miterLimit",
] as const;

type SupportedPathDrawingStyles = (typeof supportedPathDrawingStyles)[number];

const supportedFillStrokeStyles = ["fillStyle", "strokeStyle"] as const;
type SupportedFillStrokeStyles = (typeof supportedFillStrokeStyles)[number];

type Style = Pick<CanvasPathDrawingStyles, SupportedPathDrawingStyles> &
  Pick<CanvasFillStrokeStyles, SupportedFillStrokeStyles>;

const supportedStyles = [
  ...supportedPathDrawingStyles,
  ...supportedFillStrokeStyles,
] as const;

interface LineOptions {
  ctx: CanvasRenderingContext2D;
  from: [number, number];
  to: [number, number];
  style?: Partial<Style>;
}

export function line({ ctx, from, to, style = {} }: LineOptions) {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);

  for (const property of supportedStyles) {
    if (style[property] === undefined) {
      continue;
    }
    // @ts-expect-error
    ctx[property] = style[property];
  }
  ctx.stroke();
  ctx.closePath();
}

export function circle({
  ctx,
  center,
  radius,
  style = {},
}: {
  ctx: CanvasRenderingContext2D;
  center: [number, number];
  radius: number;
  style?: Partial<Style>;
}) {
  ctx.beginPath();
  ctx.arc(center[0], center[1], radius, 0, Math.PI * 2);

  for (const property of supportedStyles) {
    if (style[property] === undefined) {
      continue;
    }
    // @ts-expect-error
    ctx[property] = style[property];
  }

  if (style.fillStyle) {
    ctx.fill();
  }

  if (style.strokeStyle) {
    ctx.stroke();
  }
}

interface BoxStyle extends Style {
  borderRadius: number;
}

export function box({
  ctx,
  position,
  dimensions,
  style = {},
}: {
  ctx: CanvasRenderingContext2D;
  position: [number, number];
  dimensions: [number, number];
  style?: Partial<BoxStyle>;
}) {
  ctx.beginPath();
  ctx.roundRect(
    position[0],
    position[1],
    dimensions[0],
    dimensions[1],
    style.borderRadius ?? 0
  );

  for (const property of supportedStyles) {
    if (style[property] === undefined) {
      continue;
    }
    // @ts-expect-error
    ctx[property] = style[property];
  }

  if (style.fillStyle) {
    ctx.fill();
  }

  if (style.strokeStyle) {
    ctx.stroke();
  }
  ctx.closePath();
}

const acceptedTextStyles = [
  "direction",
  "font",
  "fontKerning",
  "fontStretch",
  "fontVariantCaps",
  "letterSpacing",
  "textAlign",
  "textBaseline",
  "textRendering",
  "wordSpacing",
] as const;

type TextStyle = Style & CanvasTextDrawingStyles;

export function text({
  ctx,
  position,
  text,
  style = {},
}: {
  ctx: CanvasRenderingContext2D;
  position: [number, number];
  text: string;
  style?: Partial<TextStyle>;
}) {
  ctx.beginPath();

  for (const property of [...acceptedTextStyles, ...supportedStyles]) {
    if (style[property] === undefined) {
      continue;
    }
    // @ts-expect-error
    ctx[property] = style[property];
  }

  if (style.strokeStyle) {
    ctx.strokeText(text, position[0], position[1]);
  }
  if (style.fillStyle) {
    ctx.fillText(text, position[0], position[1]);
  }

  ctx.closePath();
}

function isEvaluation<K extends string>(
  style: Partial<BoxStyle> | [boolean | K, Partial<BoxStyle>]
): style is [boolean, Partial<BoxStyle>] {
  return Array.isArray(style);
}

export function styled(
  styles: (Partial<BoxStyle> | [boolean, Partial<BoxStyle>])[],
  key: never
): Partial<BoxStyle>;
export function styled<K extends string>(
  styles: (Partial<BoxStyle> | [boolean | K, Partial<BoxStyle>])[],
  evaluator: K | (() => K | boolean)
): Partial<BoxStyle>;
export function styled<K extends string | never>(
  styles: (Partial<BoxStyle> | [boolean | K, Partial<BoxStyle>])[],
  evaluator: K | (() => K | boolean) | never
): Partial<BoxStyle> {
  const finalStyle: Partial<BoxStyle> = {};

  const matchKey = typeof evaluator === "function" ? evaluator() : evaluator;

  for (const style of styles) {
    if (isEvaluation(style)) {
      const [evaluation, styleDefinition] = style;
      if (evaluation === false || evaluation !== matchKey) {
        continue;
      }

      Object.assign(finalStyle, styleDefinition);
      continue;
    }

    Object.assign(finalStyle, style);
  }

  return finalStyle;
}

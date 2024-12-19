const AND =
  "data:image/png;base64,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";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function assetsManager() {
  const assets = new Map<string, HTMLImageElement>();

  return {
    load: function* (path: string) {
      if (assets.has(path)) {
        const asset = assets.get(path);

        if (!asset) {
          yield asset;
        } else {
          return asset;
        }
      }

      loadImage(path).then((img) => {
        assets.set(path, img);
      });

      yield assets.get(path);
    },
  };
}

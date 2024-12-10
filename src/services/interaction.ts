export type InteractionContext = {
  pointerLocation: [number, number];
  mouseDown: boolean;
};

export type PointerInteractionPayload = [
  number | undefined,
  number | undefined,
  boolean | undefined
];

class InteractionEngine {
  private context: InteractionContext = {
    pointerLocation: [0, 0],
    mouseDown: false,
  };

  public getPointerLocation() {
    return this.context.pointerLocation;
  }

  public setPointerLocation(x: number, y: number) {
    this.context.pointerLocation = [x, y];
  }

  public isMouseDown() {
    return this.context.mouseDown;
  }

  public notifyPointerInteraction(pointerState: PointerInteractionPayload) {
    const [storedX, storedY] = this.context.pointerLocation;
    const storedMouseDown = this.context.mouseDown;

    const [x = storedX, y = storedY, isMouseDown = storedMouseDown] = pointerState;

    this.context.pointerLocation = [x, y];
    this.context.mouseDown = isMouseDown;
  }
}

export default InteractionEngine;

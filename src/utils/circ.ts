import type { Vector2 } from "./numbers";

export type ComponentFace = "north" | "south" | "east" | "west";

export const decodeCircCoords = (coords?: string): Vector2 => {
	const location = (coords
		?.slice(1, -1)
		.split(",")
		.map((n) => Number(n)) ?? [0, 0]) as Vector2;

	return location;
};

export const getFacingOffset = (facing: ComponentFace, size: number) => {
	switch (facing) {
		case "north":
			return [-1 * (size / 2), 0];
		case "south":
			return [-1 * (size / 2), -2 * (size / 2)];
		case "east":
			return [-2 * (size / 2), -1 * (size / 2)];
		case "west":
			return [0, -1 * (size / 2)];
	}
};

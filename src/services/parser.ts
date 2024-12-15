import { andComponentDefinition } from "src/components/AND";
import { adderComponentDefinition } from "src/components/Adder";
import { nandComponentDefinition } from "src/components/NAND";
import { norComponentDefinition } from "src/components/NOR";
import { notComponentDefinition } from "src/components/NOT";
import { orComponentDefinition } from "src/components/OR";
import { xorComponentDefinition } from "src/components/XOR";
import {
  type CircTheme,
  type CnMat2x2,
  type ComponentFace,
  type ComputableNumber,
  type Mat2x2,
  type Vector2,
  cn,
  decodeCircCoords,
  resolveCn,
} from "src/utils";
import { pt } from "src/utils/renderPoints";
import { ledComponentDefinition } from "../components/LED";
import { pinComponentDefinition } from "../components/pin";
import { wireComponentDefinition } from "../components/wire";
import type { ElectricSignal } from "./simulation";

export type ComponentState = {
	location: [number, number];
	dimensions: [number, number];
	face: ComponentFace;
};

export type DrawArguments<S> = {
	scaleFactor?: number;
	ctx: CanvasRenderingContext2D;
	theme: CircTheme;
	state: S;
	bounds: CnMat2x2;
	face: ComponentFace;
	pointerLocation: [number, number] | null;
	faceAngles: [number, number, number, number];
	ports: Port[];
	portsSignals: ElectricSignal[];
	assets: Record<string, HTMLImageElement>;
};

export type PortMode = "input" | "output";

type Port = [ComputableNumber, ComputableNumber, PortMode];

export type ComponentDefinition<S> = {
	name: string;
	parse: (values: Record<string, string | null>, component: Element) => S;
	dimensions: ((state: S) => Vector2) | Vector2;
	draw(args: DrawArguments<S>): void;
	onSignalChange: (
		ports: ElectricSignal[],
		changedPort: number,
	) => ElectricSignal[];
	onPress?(ports: ElectricSignal[]): ElectricSignal[];
	isInteractable?: boolean;
	defaultFacing: ComponentFace;
	faceAngles: [number, number, number, number];
	skipLocationCheck?: boolean;
	ports: Port[] | ((state: S) => Port[]);
	loadAssets?: () => Promise<Record<string, HTMLImageElement>>;
};

export type Component<S> = {
	name: string;
	state: S;
	facing: ComponentFace;
	draw(args: DrawArguments<S>): void;
	bounds: Mat2x2;
	onPress?(ports: ElectricSignal[]): ElectricSignal[];
	onSignalChange: (
		ports: ElectricSignal[],
		changedPort: number,
	) => ElectricSignal[];
	faceAngles: [number, number, number, number];
	ports: Port[];
	assets: Record<string, HTMLImageElement>;
};

export const getFacingOffset = (facing: ComponentFace) => {
	switch (facing) {
		case "north":
			return [cn((size) => -1 * (size / 2)), 0];
		case "south":
			return [cn((size) => -1 * (size / 2)), cn((size) => -2 * (size / 2))];
		case "east":
			return [cn((size) => -2 * (size / 2)), cn((size) => -1 * (size / 2))];
		case "west":
			return [cn((size) => 0 * (size / 2)), cn((size) => -1 * (size / 2))];
	}
};

export const parseComponent = async <S>(
	component: Element,
	{
		parse,
		dimensions,
		defaultFacing = "east",
		isInteractable = false,
		skipLocationCheck = false,
		ports,
		...defs
	}: ComponentDefinition<S>,
): Promise<Component<S>> => {
	const locationAttribute = component.getAttribute("loc");

	if (!skipLocationCheck && !locationAttribute) {
		throw new Error("Component is missing a location attribute");
	}

	const location: Vector2 =
		!locationAttribute || skipLocationCheck
			? [0, 0]
			: decodeCircCoords(locationAttribute);

	let facing = defaultFacing;

	const values: Record<string, string | null> = {};

	for (let i = 0; i < component.children.length; i++) {
		const attribute = component.children[i];
		const name = attribute.getAttribute("name");

		if (!name) {
			continue;
		}

		switch (name) {
			case "facing": {
				const value = attribute.getAttribute("val");

				if (!value) {
					continue;
				}

				facing = value as ComponentFace;
				break;
			}
			default: {
				values[name] = attribute.getAttribute("val");
			}
		}
	}

	const directionOffsets = getFacingOffset(facing);
	const state = parse(values, component);

	const ogX = location[0];
	const ogY = location[1];

	const dimensionValues = Array.isArray(dimensions)
		? dimensions
		: dimensions(state);

	const width = dimensionValues[0];
	const height = dimensionValues[1];

	const offsetX = resolveCn(directionOffsets[0], width);
	const offsetY = resolveCn(directionOffsets[1], height);

	const normalizedLocation = [ogX + offsetX, ogY + offsetY] satisfies Vector2;

	const assets = defs.loadAssets ? await defs.loadAssets() : {};

	return {
		state,
		facing,
		assets,
		ports: Array.isArray(ports) ? ports : ports(state),
		bounds: [normalizedLocation, dimensionValues],
		...defs,
	};
};

const Library = {
	Pin: pinComponentDefinition,
	LED: ledComponentDefinition,
	"NOT Gate": notComponentDefinition,
	"AND Gate": andComponentDefinition,
	"NAND Gate": nandComponentDefinition,
	"OR Gate": orComponentDefinition,
	"XOR Gate": xorComponentDefinition,
	"NOR Gate": norComponentDefinition,
	Adder: adderComponentDefinition,
};

export const parseCircuit = async (root: Element) => {
	// biome-ignore lint/suspicious/noExplicitAny: This is a hack to get around the type system
	const parsedComponents: Component<any>[] = [];

	for (let i = 0; i < root.children.length; i++) {
		const component = root.children[i];

		const type = component.tagName;
		const name = component.getAttribute("name");

		// Ignore attribute nodes for now!
		if (type === "a") {
			continue;
		}

		if (type === "wire") {
			parsedComponents.push(
				await parseComponent(component, wireComponentDefinition),
			);
			continue;
		}

		if (!name) {
			continue;
		}

		const libraryComponent = Library[name as keyof typeof Library];

		if (!libraryComponent) {
			console.log(`Unknown component type: ${name}`);
			continue;
		}

		// @ts-expect-error - This is a hack to get around the type system
		const parsedComponent = await parseComponent(component, libraryComponent);

		parsedComponents.push(parsedComponent);
	}

	return parsedComponents;
};

export const parseCircuitPorts = <S>(
	component: Component<S>,
	gridSize: number,
) => {
	const portData: [number, number, PortMode][] = [];
	for (const port of component.ports) {
		const [x, y, mode] = port;
		const [resolvedX, resolvedY] = [resolveCn(x), resolveCn(y)];
		const [rotatedPortX, rotatedPortY] = pt(
			resolvedX,
			resolvedY,
			component.bounds,
			component.facing,
			component.faceAngles,
			1,
		);

		portData.push([rotatedPortX / gridSize, rotatedPortY / gridSize, mode]);
	}

	return portData;
};

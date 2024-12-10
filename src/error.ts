export function renderError(message: string): HTMLElement {
	const div = document.createElement("div");

	div.innerText = `Error loading content: ${message}`;

	return div;
}

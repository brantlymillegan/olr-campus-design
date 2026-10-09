import { Group } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// The paths come from the Blender ribbon. Screen-space widths keep this map
// annotation readable at campus scale, including on narrow phone screens.
export async function loadCampusBoundary(scene, model, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Campus boundary paths could not load.');
  const { paths } = await response.json();
  const group = new Group();
  group.name = 'Campus boundary annotation';
  for (const [index, path] of paths.entries()) {
    const geometry = new LineGeometry().setPositions(path.flat());
    for (const [name, color, width, order] of [
      ['outline', 0x263b32, 4, 100],
      ['amber', 0xf2bb40, 2, 101]
    ]) {
      const material = new LineMaterial({ color, linewidth: width, worldUnits: false,
        depthTest: true, depthWrite: false, transparent: true, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        alphaToCoverage: true });
      const line = new Line2(geometry, material);
      line.name = `Campus boundary annotation ${index + 1} ${name}`;
      line.renderOrder = order;
      group.add(line);
    }
  }
  scene.add(group);
  // The native ribbons remain in the downloadable model. The viewer uses the
  // annotation instead so tiny ribbon shadows cannot make the line look dotted.
  model.traverse(object => {
    const name = object.name.replaceAll('_', ' ');
    if (name === 'Campus boundary • outline' || name === 'Campus boundary • amber') {
      object.visible = false;
      object.castShadow = false;
    }
  });
  return group;
}

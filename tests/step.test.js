// STEP -> GLB keeps real size and loads in three's GLTFLoader.
import fs from 'node:fs';
import { meshesToGlb } from '../tools/step2glb.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';

export default function (t) {
  t('GLB writer: a unit cube comes back through GLTFLoader with its size and colour', async () => {
    const pos = [0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0, 0, 0, 30, 10, 0, 30, 10, 20, 30, 0, 20, 30];
    const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
    const { glb, bbox } = meshesToGlb([{ name: 'box', color: [0.2, 0.4, 0.6], attributes: { position: { array: pos } }, index: { array: idx } }]);
    t.eq(bbox, [0, 0, 0, 10, 20, 30]);
    const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
    const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
    t.eq([size.x, size.y, size.z], [10, 20, 30]);
    let col = null;
    gltf.scene.traverse((o) => { if (o.isMesh) col = o.material.color; });
    // baseColorFactor is linear and three keeps it as-is in its (linear) working space
    t.near(col.r, 0.2, 1e-6); t.near(col.g, 0.4, 1e-6); t.near(col.b, 0.6, 1e-6);
  });

  t('a real maker STEP converts at real size (robot VS087 base, if present)', async () => {
    const f = 'C:/Users/denny/Downloads/cad rbt/step_VS087A4-AV6-NNU-NNNxN-xNNN/step_VS087A4-AV6-NNU-NNNxN-xNNN/VS087A4-AV6-NNU-NNNxN-xNNN-c001.stp';
    if (!fs.existsSync(f)) t.skip('sample STEP not on this PC');
    const { stepToMeshes } = await import('../tools/step2glb.js');
    const { bbox } = meshesToGlb(await stepToMeshes(f));
    t.near(bbox[3] - bbox[0], 219.8, 0.5);
    t.near(bbox[5] - bbox[2], 408.8, 0.5);
  });
}

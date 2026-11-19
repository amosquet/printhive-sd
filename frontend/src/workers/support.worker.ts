import { installSupportWorker } from '@time-estimator/browser-preview/worker';
import { readSTL } from '@time-estimator/browser-preview/stl';
import { indexTriangleSoup } from '@time-estimator/browser-preview/geometry';
import { readFullMesh, isOBJ } from '../scripts/model-file';

installSupportWorker<File>({
  decodeMesh: async (file, limits) => {
    if (isOBJ(file.name)) {
      const soup = await readFullMesh(file, file.name, limits);
      return indexTriangleSoup(soup.positions);
    }
    return readSTL(file, { limits });
  },
});

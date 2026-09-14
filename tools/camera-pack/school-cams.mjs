// School cameras are never fetched or stored. The rules live with the server
// (server/providers/cctv/school-filter.js), which also applies them to live
// open-data packs, so the pack tools and the running server can never disagree
// about what counts as a school camera.
export {
  SCHOOL_CAMERA_IDS,
  hasSchoolWord,
  isSchoolCamera,
  isSchoolLink,
  isSchoolText,
  withoutSchoolCameras,
} from '../../server/providers/cctv/school-filter.js';

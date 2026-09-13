import test from 'node:test';
import assert from 'node:assert/strict';
import { isSchoolCamera, isSchoolLink } from '../../tools/camera-pack/school-cams.mjs';

test('school, university, college and library links are never requested', () => {
  assert.equal(isSchoolLink({ text: 'U of S Bowl', url: 'http://webcam.usask.ca/' }), true);
  assert.equal(isSchoolLink({ text: 'U of S College Building', url: 'http://users.accesscomm.ca/saskweather/Webcam_UofS.htm' }), true);
  assert.equal(isSchoolLink({ text: 'Yorkton Public Library', url: 'http://users.accesscomm.ca/saskweather/Webcam_Yorkton.htm' }), true);
  assert.equal(isSchoolLink({ text: 'Campus view', url: 'https://cams.example.edu/live.jpg' }), true, 'a school host');
  assert.equal(isSchoolLink({ text: 'École Sainte-Anne', url: 'https://example.ca/' }), true);
});

test('a road named after a school is a traffic camera and stays', () => {
  assert.equal(isSchoolLink({ text: 'University Ave', url: 'http://www.gov.pe.ca/islandcam/camera1.php3' }), false);
  assert.equal(isSchoolCamera({ id: 'on511-2637', name: 'Highway 85 at University Avenue East (Looking North)', url: 'https://511on.ca/map/Cctv/2637' }), false);
  assert.equal(isSchoolCamera({ id: 'qc511-3930', name: 'Aut. 410 at boul. Université', url: 'https://www.quebec511.info/x.jpg' }), false);
  assert.equal(isSchoolCamera({ id: 'x', name: 'College Street at Bay', url: 'https://example.ca/1.jpg' }), false);
  assert.equal(isSchoolCamera({ id: 'bc-drivebc-9', name: 'Nanaimo Parkway', url: 'https://www.drivebc.ca/images/9.jpg' }), false);
});

test('school cameras already in a pack are refused by id, host or name', () => {
  assert.equal(isSchoolCamera({ id: 'nb-edmundston-umce', name: 'Edmundston (UMCE)', url: 'https://cache3.nbcams.ca/camera/EdmundstonUdeM' }), true);
  assert.equal(isSchoolCamera({ id: 'y', name: 'Downtown', url: 'https://webcam.usask.ca/bowl.jpg' }), true);
  assert.equal(isSchoolCamera({ id: 'z', name: 'Holland College waterfront', url: 'https://example.ca/2.jpg' }), true);
  assert.equal(isSchoolCamera(null), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSchoolWord, isSchoolCamera, isSchoolLink, isSchoolText } from '../../tools/camera-pack/school-cams.mjs';

test('school, university, college and library links are never requested', () => {
  assert.equal(isSchoolLink({ text: 'U of S Bowl', url: 'http://webcam.usask.ca/' }), true);
  assert.equal(isSchoolLink({ text: 'U of S College Building', url: 'http://users.accesscomm.ca/saskweather/Webcam_UofS.htm' }), true);
  assert.equal(isSchoolLink({ text: 'Yorkton Public Library', url: 'http://users.accesscomm.ca/saskweather/Webcam_Yorkton.htm' }), true);
  assert.equal(isSchoolLink({ text: 'Campus view', url: 'https://cams.example.edu/live.jpg' }), true, 'a school host');
  assert.equal(isSchoolLink({ text: 'École Sainte-Anne', url: 'https://example.ca/' }), true);
  assert.equal(isSchoolLink({ text: 'Oxford quad', url: 'https://cams.ox.ac.uk/live.jpg' }), true);
  assert.equal(isSchoolLink({ text: 'UNSW mall', url: 'https://webcams.unsw.edu.au/quad.jpg' }), true);
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

test('US roads built on school words stay: street types, named roads and cross streets', () => {
  for (const text of [
    'Indian School Rd',
    'US 5 at College Hwy',
    'I-5 at MP 227.7: College Way',
    'SR 305 @ MP 1: High School Rd',
    'Jackson Ave at College Hill Rd',
    'PA 283 @ SCHOOL HOUSE RD OVERPASS',
    'TV436 -- US-101 : AT JSO UNIVERSITY AV',
    'I-17 @S of Indian School',
    'IH35W @ Sycamore School',
    'Johnston at University',
    'CHESTNUT AND COLLEGE',
    'I-11 SB College',
    'I-210 : (113) Campus',
    'I-10 at LA 182 (N University)',
    'US 150 (University) at Cunningham',
    'University at Cameron',
    'Stearns School at North Creek',
    'Maple Ave / Yackley-College',
    'SR-91 : (572) State College',
    'London: A205 Dulwich Common/College Rd',
    'London: University St/Gower St',
    'A205 Academy Rd/Shooters Hill',
  ]) {
    assert.equal(isSchoolText(text), false, text);
  }
});

test('a school named as the place is a school camera, road or not', () => {
  for (const text of [
    'DE 24 @ BEACON MIDDLE SCHOOL',
    'US 6 at High School Access (#3035)',
    'SR 3 at Atlanta Metro College (Atlanta)',
    'US 50 MP 277.00 EB at Pueblo Community College Fremont Campus',
    'MN 120: T.H.120 NB (Century College)',
    'Charlottetown at Holland College',
    'Library at night',
    'Yorkton Public Library',
    'Scuola elementare Roma',
    'Escuela primaria',
    'Universidad de Buenos Aires',
    'Hochschule München',
    'Gymnasium Wien',
    'Bibliothek Berlin',
    'Aspen Ski School',
    'Fahrschule Mitte',
    '東京大学',
    'Diesterweg - Schule',
    'Livigno: I - Scuola Sci Centrale',
    'Ezcaray › South: Escuela de Deportes de Invierno de Valdezcaray',
    'Fossano Centro Storico - Biblioteca Civica di Fossano',
    'In front of Benjamarachutit School',
    'In front of Wat Yai School, No. 1',
  ]) {
    assert.equal(isSchoolText(text), true, text);
  }
  assert.equal(hasSchoolWord('Indian School Rd'), true, 'the raw word is still reported');
  assert.equal(hasSchoolWord('Main St at 5th Ave'), false);
});

test('a school named by abbreviation after its name is a school camera', () => {
  for (const text of [
    'GWIN-433_538: Spalding Dr at Norcross HS',
    'I-490 at Gates HS',
    'S LITTLE CREEK RD @ E DOVER ELEM',
    'FOULK RD @ BRANDYWINE HS',
    'GWIN-509_197: Steve Reynolds Blvd at Meadowcreek High Sch Dw N',
    'ALPH-0032: Webb Bridge Rd at Alpharetta HS (Alpharetta)',
    'IL 43 at Deerfield HS',
    'Hart at Barrington HS (Cell)',
    '94 @ Francis Howell HS',
    'GWIN-261_669: Old Peachtree Rd at Peachtree Ridge Hs',
    'GWIN-399_523: SR 124 at Mill Creek Hs',
    'PAUL-0056: SR 61 at Paulding HS/Aiken Dr (PAULDING)',
    'SH321 @ Dayton HS Driveway',
    'US69/287 @ Lumberton HS N',
    'US69/287 @ Lumberton Middle',
    'Oak St at Lincoln Jr High',
    'Main St at Washington Elem',
  ]) {
    assert.equal(isSchoolText(text), true, text);
  }
});

test('roads and road positions built on school abbreviations stay', () => {
  for (const text of [
    'CARR-0201: SR 1 at Prmy Sch Rd (CARROLL)',
    'SR 305 @ MP 1: High School Rd',
    'US 1 at Norcross HS Rd',
    'Main St at Jr High Rd',
    'Needles Ferry Bend Middle',
    'US 322 @ POTTERS MILLS MIDDLE',
    'US 322 @ MIDDLE OF SEVEN MOUNTAINS',
    'D2 - N Front St @ Lansing Bridge (Middle)',
    'IH20 @ Ranger Hill (Middle)',
    'I-376 @ MM 68.3 (GREENTREE HIL - MIDDLE)',
    'WSF Lopez Ferry Holding Middle',
    'I-96 @ Middle Belt',
    'Highway 407 at Middle Road',
    'I-12 at Middle Colyell Creek',
  ]) {
    assert.equal(isSchoolText(text), false, text);
  }
});

test('a traffic system camera named by two crossing roads is not a school camera', () => {
  for (const [name, url] of [
    ['Broadway University', 'https://511.idaho.gov/map/Cctv/1074'],
    ['Capitol University', 'https://511.idaho.gov/map/Cctv/1075'],
    ['University Joyce-LL', 'https://511.idaho.gov/map/Cctv/1140'],
    ['Broadway (US-20) & University', 'https://511.idaho.gov/map/Cctv/693'],
    ['Capitol & University', 'https://511.idaho.gov/map/Cctv/694'],
    ['University & Joyce', 'https://511.idaho.gov/map/Cctv/762'],
  ]) {
    assert.equal(isSchoolCamera({ id: 'us511-ID-cam-x', name, url }), false, name);
  }
  // The same two words anywhere else name the institution.
  for (const [name, url] of [
    ['Holland College', 'https://example.ca/1.jpg'],
    ['Carleton University', 'https://webcams.example.com/quad.jpg'],
    ['Broadway University', ''],
    ['Université Laval', 'https://511.example.ca/map/Cctv/1'],
    ['Pueblo Community College', 'https://511.example.gov/map/Cctv/2'],
    ['University of Idaho', 'https://511.idaho.gov/map/Cctv/3'],
  ]) {
    assert.equal(isSchoolCamera({ id: 'x', name, url }), true, name);
  }
  assert.equal(isSchoolText('Broadway University'), true, 'plain text has no traffic system to vouch for it');
});

test('an institution named after a junction or label separator is still a school camera', () => {
  for (const text of [
    'Lethbridge - University of Lethbridge',
    'Regina: University of Regina',
    'Camera: College of the North Atlantic',
    'Main St at University of Toronto',
    'I-5 at University of Washington',
    'Hwy 1 - College of New Caledonia',
    'Campus / Main Gate',
    'Campus @ North Entrance',
  ]) {
    assert.equal(isSchoolText(text), true, text);
    assert.equal(isSchoolLink({ text, url: 'https://example.ca/cam.jpg' }), true, text);
  }
  for (const text of ['Main St at University / Inner Loop', 'Wehrli-College / Hobson', 'University at Cameron', 'SR-91 : (572) State College']) {
    assert.equal(isSchoolText(text), false, text);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStatCanOutliers,
  matchStatCanGeography,
} from '../../server/providers/regional/statcan-crime.js';

const GEO = [
  {
    memberId: 1,
    memberNameEn: 'Canada',
    geoLevel: 0,
  },
  {
    memberId: 3,
    memberNameEn: "St. John's, Newfoundland and Labrador [10001]",
    geoLevel: 35,
  },
  {
    memberId: 8,
    memberNameEn: 'Saint John, New Brunswick [13310]',
    geoLevel: 35,
  },
  {
    memberId: 7,
    memberNameEn: 'New Brunswick [13]',
    geoLevel: 2,
  },
  {
    memberId: 19,
    memberNameEn: 'Toronto, Ontario [35535]',
    geoLevel: 35,
  },
];

test('table 35 geography matches Saint John CMA and not St. Johns', () => {
  const saintJohn = matchStatCanGeography(GEO, 'Saint John');
  assert.equal(saintJohn.memberId, 8);
  assert.match(saintJohn.memberNameEn, /New Brunswick/);
  assert.equal(matchStatCanGeography(GEO, "St. John's").memberId, 3);
  assert.equal(matchStatCanGeography(GEO, 'Toronto').memberId, 19);
  assert.equal(matchStatCanGeography(GEO, 'Austin'), null);
});

test('StatCan outliers flag high rates versus Canada and large year-over-year swings', () => {
  const rows = [
    {
      status: 'SUCCESS',
      object: {
        coordinate: '8.4.2.0.0.0.0.0.0.0',
        vectorDataPoint: [{ refPer: '2025-01-01', value: 2200 }],
      },
    },
    {
      status: 'SUCCESS',
      object: {
        coordinate: '1.4.2.0.0.0.0.0.0.0',
        vectorDataPoint: [{ refPer: '2025-01-01', value: 1400 }],
      },
    },
    {
      status: 'SUCCESS',
      object: {
        coordinate: '8.4.3.0.0.0.0.0.0.0',
        vectorDataPoint: [{ refPer: '2025-01-01', value: 2 }],
      },
    },
    {
      status: 'SUCCESS',
      object: {
        coordinate: '8.5.2.0.0.0.0.0.0.0',
        vectorDataPoint: [{ refPer: '2025-01-01', value: 4.2 }],
      },
    },
    {
      status: 'SUCCESS',
      object: {
        coordinate: '1.5.2.0.0.0.0.0.0.0',
        vectorDataPoint: [{ refPer: '2025-01-01', value: 2.0 }],
      },
    },
    {
      status: 'SUCCESS',
      object: {
        coordinate: '8.5.3.0.0.0.0.0.0.0',
        vectorDataPoint: [{ refPer: '2025-01-01', value: 22.5 }],
      },
    },
  ];
  const outliers = classifyStatCanOutliers(rows, {
    cityMember: GEO[2],
    canadaMember: GEO[0],
    violationById: new Map([
      [4, 'Total violent Criminal Code violations'],
      [5, 'Homicide'],
    ]),
    rateStatId: 2,
    pctStatId: 3,
  });
  assert.equal(outliers.length, 2);
  // Each outlier carries how far past its threshold it is, so the provider can
  // hand the risk assessment the strongest ones first.
  assert.ok(outliers.every((o) => Number.isFinite(o.score) && o.score >= 1));
  assert.match(outliers[0].title, /violent/i);
  assert.match(outliers[0].title, /Canada/);
  assert.match(outliers[1].title, /Homicide/);
  assert.match(outliers[1].title, /22\.5%/);
  assert.match(outliers[0].url, /3510017701/);
});

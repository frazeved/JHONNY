// FedEx Address Book — Deliver To contacts with full shipping addresses
// Used for label creation script

const ADDRESS_BOOK = {

  SHIP_FROM: {
    company:  '305 Consulting and Production Inc',
    contact:  '305 Consulting and Production Inc',
    phone:    '9174992103',
    street:   ['1800 NW 15TH AVENUE, STE 110', 'UNIT 2 GROUND'],
    city:     'POMPANO BEACH',
    state:    'FL',
    zip:      '33069',
    country:  'US',
  },

  BRO: {
    company:  'URBAN OUTFITTERS INC',
    contact:  'BRISTOL RENTAL DC',
    phone:    '',
    street:   ['2401 GREEN LN'],
    city:     'LEVITTOWN',
    state:    'PA',
    zip:      '19057',
    country:  'US',
  },

  GAP: {
    company:  'ANTHROPOLOGIE GAP',
    contact:  'URBN GAP DC',
    phone:    '',
    street:   ['755 BRACKBILL ROAD'],
    city:     'GAP',
    state:    'PA',
    zip:      '17527',
    country:  'US',
  },

  GFC: {
    company:  'ANTHROPOLOGIE',
    contact:  'URBN GAP FULFILLMENT CENTER',
    phone:    '',
    street:   ['766 BRACKBILL ROAD'],
    city:     'GAP',
    state:    'PA',
    zip:      '17527',
    country:  'US',
  },

  KC1: {
    company:  'URBAN OUTFITTERS INC',
    contact:  'KANSAS CITY KANSAS FC',
    phone:    '',
    street:   ['11681 STATE AVE'],
    city:     'KANSAS CITY',
    state:    'KS',
    zip:      '66111',
    country:  'US',
  },

  KC3: {
    company:  'URBAN OUTFITTERS INC',
    contact:  'NUULY RAYMORE RENTAL DC',
    phone:    '',
    street:   ['1300 S. DEAN AVE', 'BUILDING 3, SUITE 100'],
    city:     'RAYMORE',
    state:    'MO',
    zip:      '64083',
    country:  'US',
  },

  PFC: {
    company:  'URBN PETERBOROUGH FULFILMENT CENTER',
    contact:  'URBN PETERBOROUGH FULFILMENT CENTER',
    phone:    '',
    street:   [],          // TODO: add address
    city:     '',          // TODO
    state:    '',          // TODO
    zip:      '',          // TODO
    country:  'US',        // TODO: confirm country (UK?)
  },

  REN: {
    company:  'URBN RENO DC',
    contact:  'URBN RENO DC',
    phone:    '',
    street:   ['6640 ECHO AVE'],
    city:     'RENO',
    state:    'NV',
    zip:      '89506',
    country:  'US',
  },

  RNO: {
    company:  'ANTHROPOLOGIE',
    contact:  'URBN WEST COAST FULFILLMENT',
    phone:    '',
    street:   ['12055 MOYA BLVD'],
    city:     'RENO',
    state:    'NV',
    zip:      '89506',
    country:  'US',
  },

  YRD: {
    company:  'NUULY NAVY YARD',
    contact:  'NUULY NAVY YARD',
    phone:    '',
    street:   ['5000 SOUTH BROAD ST'],
    city:     'PHILADELPHIA',
    state:    'PA',
    zip:      '19112',
    country:  'US',
  },

};

module.exports = ADDRESS_BOOK;

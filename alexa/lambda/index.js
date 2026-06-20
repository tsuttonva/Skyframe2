'use strict';

// SkyFrame Alexa skill backend. Personal/developer-console use only.
//
// Echo devices have no GPS, so "near me" means the home location below
// (mirrors CONFIG.DEFAULT_LOCATION in web/index.html) rather than any
// device-reported position. Override via the Lambda's HOME_LAT/HOME_LON
// environment variables if needed.

var WORKER_URL = 'https://skyframe2-worker.tom-tsutton.workers.dev';
var HOME_LAT = parseFloat(process.env.HOME_LAT) || 38.6862;
var HOME_LON = parseFloat(process.env.HOME_LON) || -77.7997;
var DEFAULT_DIST_NM = 5;
var MAX_DIST_NM = 50;
var MAX_AIRCRAFT_SPOKEN = 3;

function buildResponse(speechText, shouldEndSession) {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: speechText },
      shouldEndSession: shouldEndSession !== false,
    },
  };
}

function kmToNm(km) {
  return km * 0.539957;
}

function describeAircraft(ac) {
  var nm = kmToNm(ac.dist_km).toFixed(1);
  var label = ac.callsign || ('aircraft ' + ac.icao24) || 'an unidentified aircraft';
  var alt = ac.baro_alt ? Math.round(ac.baro_alt) + ' feet' : 'an unknown altitude';
  var mil = ac.is_military ? ' Military traffic.' : '';
  return label + ', ' + alt + ', ' + nm + ' nautical miles away.' + mil;
}

async function reportPlanesNearMe(distNm) {
  var dist = Math.min(MAX_DIST_NM, Math.max(1, distNm || DEFAULT_DIST_NM));
  var url = WORKER_URL + '/flights?lat=' + HOME_LAT + '&lon=' + HOME_LON + '&dist=' + dist;

  var resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    return 'SkyFrame could not reach the radar right now. Try again in a moment.';
  }
  if (!resp.ok) {
    return 'SkyFrame could not reach the radar right now. Try again in a moment.';
  }

  var data = await resp.json();
  var aircraft = (data && data.aircraft) || [];
  aircraft.sort(function (a, b) { return a.dist_km - b.dist_km; });

  if (aircraft.length === 0) {
    return 'SkyFrame reports no aircraft within ' + dist + ' nautical miles right now.';
  }

  var top = aircraft.slice(0, MAX_AIRCRAFT_SPOKEN);
  var countText = aircraft.length === 1 ? '1 aircraft' : aircraft.length + ' aircraft';
  var intro = 'SkyFrame reports ' + countText + ' within ' + dist + ' nautical miles. ';
  return intro + top.map(describeAircraft).join(' ');
}

exports.handler = async function (event) {
  var req = event.request;

  if (req.type === 'LaunchRequest') {
    return buildResponse('Welcome to SkyFrame. Ask what planes are near you.', false);
  }

  if (req.type === 'IntentRequest') {
    var intentName = req.intent.name;

    if (intentName === 'PlanesNearMeIntent') {
      var slot = req.intent.slots && req.intent.slots.Distance;
      var distNm = slot && slot.value ? parseFloat(slot.value) : DEFAULT_DIST_NM;
      var speech = await reportPlanesNearMe(distNm);
      return buildResponse(speech, true);
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return buildResponse(
        'Ask SkyFrame what planes are near you, or give a distance, like "what planes are within 10 miles of me." Distances are in nautical miles.',
        false
      );
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent' || intentName === 'AMAZON.NavigateHomeIntent') {
      return buildResponse('Goodbye.', true);
    }

    return buildResponse('Sorry, I did not understand that. Try asking what planes are near you.', false);
  }

  return buildResponse('Goodbye.', true);
};

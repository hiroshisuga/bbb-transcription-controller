'use strict'

const Logger = require('./lib/logger');

const config = require('config');
const { fork } = require('child_process');
const fs = require('fs');

let GLADIA_PROXY_PROCESS;
const runGladiaProxy = () => {
  const outputFile = 'gladia-proxy.log';

  const outputStream = fs.createWriteStream(outputFile);

  outputStream.on('open', () => {
    // Spawn the child process
    GLADIA_PROXY_PROCESS = fork('gladia-proxy.js', [], {
      stdio: [null, outputStream, outputStream, 'ipc']
    });

    GLADIA_PROXY_PROCESS.on('exit', (code, signal) => {
      Logger.info(`Closing Gladia proxy code: ${code} signal: ${signal}`);
    });
  });

  Logger.info("Starting Gladia proxy");
}

if (config.get('gladia.proxy.enabled')) {
  runGladiaProxy();
}

const { tryParseJSON }  = require('./lib/utils');

const EventEmitter = require('events').EventEmitter;
const C = require('./lib/Constants');
const BigBlueButtonGW = require('./lib/bbb-gw');

const bbbGW = new BigBlueButtonGW();

const socketStatus = {};
const socketIsStopping = {};

const REDIS_CHANNEL = config.get('redis.publishChannel')

bbbGW.addSubscribeChannel(REDIS_CHANNEL);
bbbGW.on('MeetingCreatedEvtMsg', (header, payload) => {
  setVoiceToMeeting(payload.props.voiceProp.voiceConf, payload.props.meetingProp.intId);
});

bbbGW.on('UserSpeechLocaleChangedEvtMsg', (header, payload) => {
  const { meetingId, userId } = header;
  const { provider, locale } = payload;

  Logger.info("Speech changed " + userId + ' ' + provider + ' ' + locale);

  setProvider(userId, provider);
  setUserLocale(userId, locale);
});

const REDIS_VOICE_ID_KEY = 'bbb-transcription-manager_voiceToMeeting';
const getVoiceToMeeting = (voiceConf, cb) => {
  bbbGW.getKey(REDIS_VOICE_ID_KEY + '_' + voiceConf, cb);
};

const setVoiceToMeeting = (voiceConf, meetingId, cb) => {
  bbbGW.setKey(REDIS_VOICE_ID_KEY + '_' + voiceConf, meetingId, cb);
};

const REDIS_USER_LOCALE_KEY = 'bbb-transcription-manager_locale';
const getUserLocale = (userId, cb) => {
  bbbGW.getKey(REDIS_USER_LOCALE_KEY + '_' + userId, cb);
};

const setUserLocale = (userId, locale, cb) => {
  bbbGW.setKey(REDIS_USER_LOCALE_KEY + '_' + userId, locale, cb);
};

const REDIS_TRANSCRIPTION_PROVIDER_KEY = 'bbb-transcription-manager_provider';
const getProvider = (userId, cb) => {
  bbbGW.getKey(REDIS_TRANSCRIPTION_PROVIDER_KEY + '_' + userId, cb);
};

const setProvider = (userId, provider, cb) => {
  bbbGW.setKey(REDIS_TRANSCRIPTION_PROVIDER_KEY + '_' + userId, provider, cb);
};

const EslWrapper = require('./lib/esl-wrapper');
const eslWrapper = new EslWrapper();

const SAMPLE_RATE = config.get("sampleRate");

const INCLUDE_PARTIAL_RESULTS = config.get("includePartialResults");

const getServerUrl = (userId, cb) => {

  getProvider(userId, (err, provider) => {
    getUserLocale(userId, (err, locale) => {

      if (provider && provider != '' && locale && locale != '') {
        const serverUrl = config.get(provider === 'gladia' ? 'gladia.server' : provider + '.servers.' + locale);

        return cb(serverUrl, provider, locale);
      } else {
        return cb(null);
      }
    });
  });
};

const makeMessage = (meetingId, userId, locale, transcript, result) => {
  return {
    envelope: {
      name: 'UpdateTranscriptPubMsg',
      routing: {
        meetingId,
        userId,
      },
      timestamp: Date.now(),
    },
    core: {
      header: {
        name: 'UpdateTranscriptPubMsg',
        meetingId,
        userId,
      },
      body: {
        transcriptId: userId + '-'+ Date.now(),
        start: '0',
        end: '0',
        text: '',
        transcript,
        locale,
        result,
      },
    }
  };
};

const startAudioFork = (channelId, userId) => {
  getServerUrl(userId, (serverUrl, provider, language) => {
    if (!serverUrl) {
      Logger.warn("No provider set, not transcribing");
      return;
    }

    const initialMessage = JSON.parse(config.get(provider + '.startMessage'));

    if (provider === 'vosk') {
      initialMessage.config.sample_rate = SAMPLE_RATE + '000';
    }

    if (provider === 'gladia') {
      initialMessage.sample_rate = parseInt(SAMPLE_RATE + '000')
      initialMessage.language = language.slice(0,2);
    }

    if (socketIsStopping[channelId]) {
      socketIsStopping[channelId] = false;
    }

    if (!socketStatus[channelId]) {
      eslWrapper._executeCommand(`uuid_audio_fork ${channelId} start ${serverUrl} mono ${SAMPLE_RATE}k ${JSON.stringify(initialMessage)}`);
      socketStatus[channelId] = true;
    }
  });
};

const stopAudioFork = (channelId, userId) => {
    const endMessage = JSON.parse(config.get('vosk.endMessage'));

    if (socketStatus[channelId]) {
      if (!socketIsStopping[channelId]) {
        socketIsStopping[channelId] = true;
      } else {
        eslWrapper._executeCommand(`uuid_audio_fork ${channelId} stop ${JSON.stringify(endMessage)}`);

        socketStatus[channelId] = false;
        socketIsStopping[channelId] = false;
      }
    }
};

let prev_transcription = '';
eslWrapper.onModAudioForkJSON((msg) => {
  const channelId = msg.getHeader('Channel-Call-UUID')

  getVoiceToMeeting(msg.getHeader('variable_conference_name'), (err, meetingId) => {

    const userId = msg.getHeader('Caller-Username').split('_').slice(0,2).join('_');
    getUserLocale(userId, (err, locale) => {
      const ignore = [ '', 'the']

      const body = tryParseJSON(msg.body);
      const transcription = body.text || body.partial;

      if (body.partial && !INCLUDE_PARTIAL_RESULTS) {
        Logger.debug('Discard partial utterance', body.partial);
        return;
      }

      if ((ignore.includes(transcription) || transcription == prev_transcription) && !body.text) {
        return;
      }

      if (body.text) {
        Logger.info(`Final text is: ${body.text}`);
      }

      prev_transcription = transcription;
      const result = Boolean(body.text);
      const payload = makeMessage(meetingId, userId, body.locale || locale, transcription, result);

      bbbGW.publish(JSON.stringify(payload), C.TO_AKKA_APPS_CHAN_2x);

      if (socketIsStopping[channelId] && result) {
        stopAudioFork(channelId);
      }
    });
  });
});

const handleChannelAnswer = (channelId, callId) => {
  Logger.info(`FS: Associating channel ${channelId} ${callId}`);
}

const handleChannelHangup = (channelId, callId) => {
  Logger.info(`FS: channel hangup ${channelId} ${callId}`);
  stopAudioFork(channelId);
}

const handleFloorChanged = (roomId, newFloorMemberId) => {
  Logger.info(`FS: floor changed ${roomId} ${newFloorMemberId}`);
}

const handleStartTalking = (channelId, userId) => {
  Logger.info(`FS: Start talking ${channelId} userId: ${userId}`);
}

const handleStopTalking = (channelId, userId) => {
  Logger.info(`FS: Stop Talking ${channelId} userId: ${userId}`);
} 

eslWrapper.on(EslWrapper.EVENTS.CHANNEL_ANSWER, handleChannelAnswer);
eslWrapper.on(EslWrapper.EVENTS.CHANNEL_HANGUP, handleChannelHangup);
eslWrapper.on(EslWrapper.EVENTS.FLOOR_CHANGED, handleFloorChanged);
eslWrapper.on(EslWrapper.EVENTS.START_TALKING, handleStartTalking);
eslWrapper.on(EslWrapper.EVENTS.STOP_TALKING, handleStopTalking);
eslWrapper.on(EslWrapper.EVENTS.MUTED, handleStopTalking);

eslWrapper._connect();

const exitCleanup = () => {
  Logger.info('Closing process, cleaning up.');

  if (GLADIA_PROXY_PROCESS) {
    Logger.info('Killing gladia proxy');
    GLADIA_PROXY_PROCESS.kill('SIGINT');
  }
  process.exit();
}

process.on('SIGINT', exitCleanup);
process.on('SIGQUIT', exitCleanup);
process.on('SIGTERM', exitCleanup);

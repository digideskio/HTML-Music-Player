"use strict";
var FileView = require("./FileView");

const DEPENDS_ON_EARLIER_FRAMES_FLAG = 0x80000000 ;

const mp3_freq_tab = new Uint16Array([44100, 48000, 32000]);
const mp3_bitrate_tab = new Uint16Array([
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160
]);

// TODO: Lots of duplication with demuxer.
function Mp3SeekTable() {
    this.frames = 0;
    this.tocFilledUntil = 0;
    this.table = new Array(128);
    this.lastFrameSize = 0;
}

Mp3SeekTable.prototype.fillUntil = function(time, metadata, fileView) {
    if (this.tocFilledUntil >= time) return;
    var offset = metadata.dataStart;
    var end = metadata.dataEnd;

    var bufferSize = metadata.maxByteSizePerSample * metadata.samplesPerFrame | 0;
    var maxFrames = Math.ceil(time * (metadata.sampleRate / (1152 >> metadata.lsf)));
    var lsf = metadata.lsf ? 1 : 0;

    var table = this.table;
    var offset, frames;
    if (this.frames > 0) {
        frames = this.frames;
        offset = table[this.frames - 1] + this.lastFrameSize;
    } else {
        frames = 0;
        offset = metadata.dataStart;
    }

    mainLoop: while (offset < end && frames < maxFrames) {
        var buffer = fileView.bufferOfSizeAt(bufferSize, offset);
        var header = 0;

        do {
            var i = offset - fileView.start;
            header = ((header << 8) | buffer[i]) | 0;

            if ((header & 0xffe00000) !== -2097152) {
                continue;
            }

            if ((header & (3 << 17)) !== (1 << 17)) {
                continue;
            }

            if ((header & (0xF << 12)) === (0xF << 12)) {
                continue;
            }

            if ((header & (3 << 10)) === (3 << 10)) {
                continue;
            }

            var lsf, mpeg25;
            if ((header & (1<<20)) !== 0) {
                lsf = (header & (1<<19)) !== 0 ? 0 : 1;
                mpeg25 = 0;
            } else {
                lsf = 1;
                mpeg25 = 1;
            }

            var sampleRateIndex = ((header >> 10) & 3);
            if (sampleRateIndex < 0 || sampleRateIndex >= mp3_freq_tab.length) continue;
            var sampleRate = mp3_freq_tab[((header >> 10) & 3)] >> (lsf + mpeg25);

            var bitRateIndex = (lsf * 15) + ((header >> 12) & 0xf);
            if (bitRateIndex < 0 || bitRateIndex >= mp3_bitrate_tab.length) continue;
            var bitRate = mp3_bitrate_tab[bitRateIndex] * 1000;

            table[frames] = (offset - 3);
            frames++;
                

            var padding = (header >> 9) & 1;
            var frame_size = (((bitRate / 1000) * 144000) / ((sampleRate << lsf)) |0) + padding;
            this.lastFrameSize = frame_size;
            offset += (frame_size - 4);

            if (frames >= maxFrames) {
                break mainLoop;
            }
            break;
        } while (++offset < end);
    }
    this.frames = frames;
    this.tocFilledUntil = (metadata.samplesPerFrame / metadata.sampleRate) * frames;
};
function seekMp3(time, metadata, context, fileView) {
    time = Math.min(metadata.duration, Math.max(0, time));
    var table = metadata.seekTable;

    if (!table) {
        table = metadata.seekTable = new Mp3SeekTable();
    }

    var timePerFrame = (metadata.samplesPerFrame / metadata.sampleRate);
    table.fillUntil(time + timePerFrame, metadata, fileView);

    var index = 0;
    
    var frame = Math.max(0, Math.min(table.frames - 1, Math.round(time / timePerFrame)));
    var currentTime = frame * timePerFrame;
    var offset = table.table[frame];

    return {
        time: currentTime,
        offset: offset
    };
}

function seek(type, time, metadata, context, fileView) {
    if (type === "mp3") {
        return seekMp3(time, metadata, context, fileView);
    }
    throw new Error("unsupported type");
}

module.exports = seek;
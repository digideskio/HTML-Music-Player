import {Mp3SeekTable} from "audio/backend/demuxer";

const seekMp3 = async (time, metadata, context, fileView, cancellationToken) => {
    time = Math.min(metadata.duration, Math.max(0, time));
    const frames = ((metadata.duration * metadata.sampleRate) / metadata.samplesPerFrame) | 0;
    let frame = (time / metadata.duration * frames) | 0;
    let currentTime = frame * (metadata.samplesPerFrame / metadata.sampleRate);
    // Target an earlier frame to build up the bit reservoir for the actual frame.
    let targetFrame = Math.max(0, frame - 9);
    // The frames are only decoded to build up the bit reservoir and should not be actually played back.
    let samplesToSkip = (frame - targetFrame) * metadata.samplesPerFrame;

    let offset;

    if (!metadata.vbr) {
        offset = (metadata.dataStart + targetFrame * metadata.averageFrameSize) | 0;
    } else if (metadata.toc) {
        // Xing seek tables.
        frame = ((Math.round(frame / frames * 100) / 100) * frames) | 0;
        currentTime = (frame + 1) * (metadata.samplesPerFrame / metadata.sampleRate);
        samplesToSkip = metadata.samplesPerFrame;
        targetFrame = frame;
        const tocIndex = Math.min(99, Math.round(frame / frames * 100) | 0);
        const offsetPercentage = metadata.toc[tocIndex] / 256;
        offset = (metadata.dataStart + (offsetPercentage * (metadata.dataEnd - metadata.dataStart))) | 0;
    } else {
        let table = metadata.seekTable;
        if (!table) {
            table = metadata.seekTable = new Mp3SeekTable();
        }
        await table.fillUntil(time + (metadata.samplesPerFrame / metadata.sampleRate), metadata, fileView, cancellationToken);
        // Trust that the seek offset given by VBRI metadata will not be to a frame that has bit
        // Reservoir. VBR should have little need for bit reservoir anyway.
        if (table.isFromMetaData) {
            frame = table.closestFrameOf(frame);
            currentTime = (frame + 1) * (metadata.samplesPerFrame / metadata.sampleRate);
            samplesToSkip = metadata.samplesPerFrame;
            offset = table.offsetOfFrame(frame);
            targetFrame = frame;
        } else {
            offset = table.offsetOfFrame(targetFrame);
        }
    }

    if (targetFrame === 0) {
        samplesToSkip = metadata.encoderDelay;
    }

    return {
        time: currentTime,
        offset: Math.max(metadata.dataStart, Math.min(offset, metadata.dataEnd)),
        samplesToSkip,
        frame: targetFrame
    };
};

const doSeek = (type, time, metadata, context, fileView, cancellationToken) => {
    if (type === `mp3`) {
        return seekMp3(time, metadata, context, fileView, cancellationToken);
    }
    throw new Error(`unsupported type`);
};

export default function seek(type, time, metadata, context, fileView, cancellationToken) {
    return doSeek(type, time, metadata, context, fileView, cancellationToken);
}

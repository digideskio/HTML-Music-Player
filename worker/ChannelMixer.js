"use strict";

const bufferCache = Object.create(null);
const getBuffer = function(samples) {
    var key = samples + " ";
    var result = bufferCache[key];
    if (!result) {
        result = new Float32Array(samples);
        bufferCache[key] = result;
    } else {
        for (var i = 0; i < result.length; ++i) result[i] = 0;
    }
    return result;
}; 

function ChannelMixer(channels) {
    this.channels = channels;
}

ChannelMixer.prototype.setChannels = function(channels) {
    this.channels = channels;
};

ChannelMixer.prototype.getChannels = function() {
    return this.channels;
};

ChannelMixer.prototype.mix = function(input, length) {
    const inputChannels = input.length;
    if (inputChannels === this.channels) {
        return input;
    }
    if (length === undefined) length = input[0].length;

    var outputChannels = this.channels;
    if (outputChannels === 1) {
        if (inputChannels === 2) {
            return this._mix2to1(input, length);
        } else if (inputChannels === 4) {
            return this._mix4to1(input, length);
        } else if (inputChannels === 6) {
            return this._mix6to1(input, length);
        }
    } else if (outputChannels === 2) {
        if (inputChannels === 1) {
            return this._mix1to2(input, length);
        } else if (inputChannels === 4) {
            return this._mix4to2(input, length);
        } else if (inputChannels === 6) {
            return this._mix6to2(input, length);            
        }
    } else if (outputChannels === 4) {
        if (inputChannels === 1) {
            return this._mix1to4(input, length);
        } else if (inputChannels === 2) {
            return this._mix2to4(input, length);
        }   else if (inputChannels === 6) {
            return this._mix6to4(input, length);
        }
    } else if (outputChannels === 6) {
        if (inputChannels === 1) {
            return this._mix1to6(input, length);
        } else if (inputChannels === 2) {
            return this._mix2to6(input, length);
        } else if (inputChannels === 4) {
            return this._mix4to6(input, length);
        }
    }

    return this._mixAnyToAny(input, length);
};

ChannelMixer.prototype._mix1to2 = function(input) {
    return [input[0], input[0]];
};

ChannelMixer.prototype._mix1to4 = function(input, length) {
    var silent = getBuffer(length);
    return [input[0], input[0], silent, silent];
};

ChannelMixer.prototype._mix1to6 = function(input, length) {
    var silent = getBuffer(length);
    return [
        silent,
        silent,
        input[0],
        silent,
        silent,
        silent
    ];
};

ChannelMixer.prototype._mix2to1 = function(input, length) {
    var ret = input[0];
    for (var i = 0; i < length; ++i) {
        ret[i] = Math.fround(Math.fround(input[0][i] + input[1][i]) / 2);
    }
    return [ret];
};

ChannelMixer.prototype._mix2to4 = function(input, length) {
    var silent = getBuffer(length);
    return [input[0], input[1], silent, silent];
};

ChannelMixer.prototype._mix2to6 = function(input, length) {
    var silent = getBuffer(length);
    return [input[0], input[1], silent, silent, silent, silent];
};

ChannelMixer.prototype._mix4to1 = function(input, length) {
    var ret = input[0];
    for (var i = 0; i < length; ++i) {
        ret[i] = (input[0][i] + input[1][i] + input[2][i] + input[3][i]) / 4;
    }
    return [ret];
};

ChannelMixer.prototype._mix4to2 = function(input, length) {
    var ret0 = input[0];
    var ret1 = input[1];
    for (var i = 0; i < length; ++i) {
        ret0[i] = (input[0][i] + input[2][i]) / 2;
        ret1[i] = (input[1][i] + input[3][i]) / 2;
    }
    return [ret0, ret1];
};

ChannelMixer.prototype._mix4to6 = function(input, length) {
    var silent = getBuffer(length);
    return [input[0], input[1], silent, silent, input[2], input[3]];
};


ChannelMixer.prototype._mix6to1 = function(input, length) {
    var ret = input[0];

    for (var i = 0; i < length; ++i) {
        var L = input[0][i];
        var R = input[1][i];
        var C = input[2][i];
        var SL = input[4][i];
        var SR = input[5][i];
        ret[i] = Math.fround(0.7071067811865476 * (L + R)) + C + Math.fround(0.5 * (SL + SR));
    }
    return [ret];
};

ChannelMixer.prototype._mix6to2 = function(input, length) {
    var ret0 = input[0];
    var ret1 = input[1];

    for (var i = 0; i < length; ++i) {
        var L = input[0][i];
        var R = input[1][i];
        var C = input[2][i];
        var SL = input[4][i];
        var SR = input[5][i];
        ret0[i] = L + Math.fround(0.7071067811865476 * Math.fround(C + SL));
        ret1[i] = R + Math.fround(0.7071067811865476 * Math.fround(C + SR));
    }

    return [ret0, ret1];
};

ChannelMixer.prototype._mix6to4 = function(input, length) {
    var ret0 = input[0];
    var ret1 = input[1];
    var ret2 = input[4];
    var ret3 = input[5];

    for (var i = 0; i < length; ++i) {
        var L = input[0][i];
        var R = input[1][i];
        var C = input[2][i];
        ret0[i] = L + Math.fround(0.7071067811865476 * C);
        ret1[i] = R + Math.fround(0.7071067811865476 * C);
    }

    return [ret0, ret1, ret2, ret3];
};

ChannelMixer.prototype._mixAnyToAny = function(input, length) {
    var channels = this.channels;

    if (channels < input.length) {
        return input.slice(0, channels);
    } else if (channels > input.length) {
        var ret = new Array(channels);
        var i = 0;
        for ( ; i < length; ++i) {
            ret[i] = input[i];
        }
        var silent = getBuffer(length);
        for ( ; i < channels; ++i) {
            ret[i] = silent;
        }
        return ret;
    } else {
        return input;
    }
};
module.exports = ChannelMixer;

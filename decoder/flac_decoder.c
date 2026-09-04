#include <FLAC/stream_decoder.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define DESCRIPTION_CAPACITY 42u
#define OUTPUT_CAPACITY (384u * 1024u)

__attribute__((import_module("env"), import_name("miso_flac_read")))
extern int32_t miso_flac_read(uint8_t *target, uint32_t maximum_bytes);

typedef struct {
    FLAC__StreamDecoder *decoder;
    uint8_t description[DESCRIPTION_CAPACITY];
    uint32_t description_offset;
    uint32_t description_length;
    uint8_t output[OUTPUT_CAPACITY];
    uint32_t output_length;
    uint32_t output_frames;
    uint32_t expected_rate;
    uint32_t expected_channels;
    uint32_t expected_depth;
    uint32_t minimum_block_samples;
    uint32_t maximum_block_samples;
    uint32_t previous_block_samples;
    uint64_t expected_frames;
    uint64_t decoded_frames;
    uint64_t decoded_bytes;
    int32_t callback_error;
    int32_t initialized;
} DecoderState;

static DecoderState state;

static FLAC__StreamDecoderReadStatus read_callback(
    const FLAC__StreamDecoder *decoder, FLAC__byte buffer[], size_t *bytes, void *client_data
) {
    DecoderState *self = (DecoderState *)client_data;
    size_t available;
    size_t copied;
    int32_t result;
    (void)decoder;
    if (*bytes == 0) return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    if (self->description_offset < self->description_length) {
        available = self->description_length - self->description_offset;
        copied = available < *bytes ? available : *bytes;
        memcpy(buffer, self->description + self->description_offset, copied);
        self->description_offset += (uint32_t)copied;
        *bytes = copied;
        return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
    }
    result = miso_flac_read(buffer, (uint32_t)*bytes);
    if (result > 0 && (uint32_t)result <= (uint32_t)*bytes) {
        *bytes = (size_t)result;
        return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
    }
    *bytes = 0;
    if (result == 0) return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
    self->callback_error = 1;
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
}

static FLAC__StreamDecoderWriteStatus write_callback(
    const FLAC__StreamDecoder *decoder,
    const FLAC__Frame *frame,
    const FLAC__int32 *const channels[],
    void *client_data
) {
    DecoderState *self = (DecoderState *)client_data;
    uint32_t block = frame->header.blocksize;
    uint32_t channel;
    uint32_t sample;
    uint32_t width;
    uint64_t bytes;
    uint64_t sample_position;
    (void)decoder;
    sample_position = frame->header.number.sample_number;
    if (self->output_length != 0 || block == 0 || block > self->maximum_block_samples ||
        (self->previous_block_samples != 0 && self->previous_block_samples < self->minimum_block_samples) ||
        frame->header.number_type != FLAC__FRAME_NUMBER_TYPE_SAMPLE_NUMBER ||
        sample_position != self->decoded_frames ||
        frame->header.sample_rate != self->expected_rate ||
        frame->header.channels != self->expected_channels ||
        frame->header.bits_per_sample != self->expected_depth) {
        self->callback_error = 2;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    width = self->expected_depth / 8u;
    bytes = (uint64_t)block * self->expected_channels * width;
    if (bytes > OUTPUT_CAPACITY || self->decoded_frames + block > self->expected_frames) {
        self->callback_error = 3;
        return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    for (sample = 0; sample < block; sample++) {
        for (channel = 0; channel < self->expected_channels; channel++) {
            uint32_t offset = (sample * self->expected_channels + channel) * width;
            uint32_t value = (uint32_t)channels[channel][sample];
            self->output[offset] = (uint8_t)value;
            self->output[offset + 1] = (uint8_t)(value >> 8);
            if (width == 3u) self->output[offset + 2] = (uint8_t)(value >> 16);
        }
    }
    self->output_length = (uint32_t)bytes;
    self->output_frames = block;
    self->previous_block_samples = block;
    self->decoded_frames += block;
    self->decoded_bytes += bytes;
    return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}

static void metadata_callback(
    const FLAC__StreamDecoder *decoder, const FLAC__StreamMetadata *metadata, void *client_data
) {
    DecoderState *self = (DecoderState *)client_data;
    (void)decoder;
    if (metadata->type != FLAC__METADATA_TYPE_STREAMINFO ||
        metadata->data.stream_info.sample_rate != self->expected_rate ||
        metadata->data.stream_info.channels != self->expected_channels ||
        metadata->data.stream_info.bits_per_sample != self->expected_depth ||
        metadata->data.stream_info.min_blocksize != self->minimum_block_samples ||
        metadata->data.stream_info.max_blocksize != self->maximum_block_samples) self->callback_error = 4;
}

static void error_callback(
    const FLAC__StreamDecoder *decoder, FLAC__StreamDecoderErrorStatus status, void *client_data
) {
    DecoderState *self = (DecoderState *)client_data;
    (void)decoder;
    self->callback_error = 100 + (int32_t)status;
}

uint32_t miso_flac_decoder_abi_version(void) { return 2u; }
uint8_t *miso_flac_decoder_description_ptr(void) { return state.description; }
uint32_t miso_flac_decoder_description_capacity(void) { return DESCRIPTION_CAPACITY; }
uint8_t *miso_flac_decoder_output_ptr(void) { return state.output; }
uint32_t miso_flac_decoder_output_length(void) { return state.output_length; }
uint32_t miso_flac_decoder_output_frames(void) { return state.output_frames; }
int32_t miso_flac_decoder_callback_error(void) { return state.callback_error; }
int32_t miso_flac_decoder_state(void) {
    return state.decoder == NULL ? -1 : (int32_t)FLAC__stream_decoder_get_state(state.decoder);
}

int32_t miso_flac_decoder_initialize(
    uint32_t description_length,
    uint32_t sample_rate,
    uint32_t channels,
    uint32_t depth,
    uint32_t minimum_block_samples,
    uint32_t maximum_block_samples,
    uint32_t expected_frames_low,
    uint32_t expected_frames_high
) {
    FLAC__StreamDecoderInitStatus status;
    if (state.decoder != NULL || description_length != DESCRIPTION_CAPACITY ||
        (channels != 1u && channels != 2u) || (depth != 16u && depth != 24u) ||
        minimum_block_samples < 16u || maximum_block_samples < minimum_block_samples ||
        maximum_block_samples > 65535u) return -1;
    state.description_length = description_length;
    state.expected_rate = sample_rate;
    state.expected_channels = channels;
    state.expected_depth = depth;
    state.minimum_block_samples = minimum_block_samples;
    state.maximum_block_samples = maximum_block_samples;
    state.expected_frames = ((uint64_t)expected_frames_high << 32) | expected_frames_low;
    state.decoder = FLAC__stream_decoder_new();
    if (state.decoder == NULL) return -2;
    if (!FLAC__stream_decoder_set_md5_checking(state.decoder, true)) return -3;
    status = FLAC__stream_decoder_init_stream(
        state.decoder, read_callback, NULL, NULL, NULL, NULL,
        write_callback, metadata_callback, error_callback, &state
    );
    if (status != FLAC__STREAM_DECODER_INIT_STATUS_OK) return -10 - (int32_t)status;
    state.initialized = 1;
    if (!FLAC__stream_decoder_process_until_end_of_metadata(state.decoder) || state.callback_error != 0) return -20;
    return 0;
}

/* 1: output block, 2: true EOF, 0: progress without output, negative: terminal. */
int32_t miso_flac_decoder_process_single(void) {
    FLAC__StreamDecoderState decoder_state;
    if (!state.initialized || state.decoder == NULL || state.output_length != 0) return -1;
    if (!FLAC__stream_decoder_process_single(state.decoder) || state.callback_error != 0) return -2;
    if (state.output_length != 0) return 1;
    decoder_state = FLAC__stream_decoder_get_state(state.decoder);
    return decoder_state == FLAC__STREAM_DECODER_END_OF_STREAM ? 2 : 0;
}

void miso_flac_decoder_release_output(void) {
    state.output_length = 0;
    state.output_frames = 0;
}

int32_t miso_flac_decoder_finish(void) {
    uint64_t expected_bytes;
    FLAC__bool valid;
    if (!state.initialized || state.decoder == NULL ||
        FLAC__stream_decoder_get_state(state.decoder) != FLAC__STREAM_DECODER_END_OF_STREAM) return -1;
    expected_bytes = state.expected_frames * state.expected_channels * (state.expected_depth / 8u);
    if (state.decoded_frames != state.expected_frames || state.decoded_bytes != expected_bytes ||
        state.previous_block_samples == 0 || state.previous_block_samples > state.maximum_block_samples) return -2;
    valid = FLAC__stream_decoder_finish(state.decoder);
    state.initialized = 0;
    return valid && state.callback_error == 0 ? 0 : -3;
}

void miso_flac_decoder_destroy(void) {
    if (state.decoder != NULL) FLAC__stream_decoder_delete(state.decoder);
    memset(&state, 0, sizeof(state));
}

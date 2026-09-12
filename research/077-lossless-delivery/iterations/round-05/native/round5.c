/*
 * Issue #77 round 5: select a charged spatial, temporal, or stacked path.
 *
 * Round 4 is included read-only for the RSD reader, exact spatial transform,
 * Rice/rANS coder, and checked PCM restoration.  Round 5 adds only the
 * candidate selection and inverse pipeline; it never changes an earlier
 * round's source or artifact.
 */
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#define I77_ROUND4_NO_MAIN
#include "../../round-04/native/round4.c"
#undef I77_ROUND4_NO_MAIN

#include <inttypes.h>
#include <sys/types.h>

#define R5_MAGIC "I77MIX05"
#define R5_SHAPE 1u
#define R5_SPATIAL_PROFILE 2u
#define R5_MAX_POLICY 2u
#define R5_FIR_PROFILE 3u
#define R5_SPATIAL_TAPS 5u
#define R5_COEFFICIENT_BYTES (2u * R5_SPATIAL_TAPS)

typedef struct {
    uint64_t coefficient_bytes;
    uint64_t plan_rows;
    uint64_t cheap_frames;
    uint64_t temporal_frames;
    uint64_t stacked_frames;
    uint64_t spatial_frames;
    uint64_t fir_frames;
    uint64_t reference0_frames;
    uint64_t reference1_frames;
    uint64_t predictive_residuals;
    uint64_t fir_residuals;
    uint64_t fir_updates;
    uint64_t fir_prediction_clamp;
    uint64_t fir_coefficient_clamp;
    uint64_t fir_modular_wrap;
    uint64_t spatial_prediction_clamp;
    uint64_t spatial_modular_wrap;
} R5_Counters;

typedef struct {
    R2_Frame frame;
    uint8_t selector;
    int16_t q[R5_SPATIAL_TAPS];
    uint64_t rice_bytes;
    int valid;
    R3_Counters fir;
    R4_Counters spatial;
} R5_Candidate;

typedef struct {
    uint64_t cheap_rice_bytes;
    uint64_t temporal_rice_bytes;
    uint64_t stacked_rice_bytes;
    uint64_t selected_rice_bytes;
    uint8_t selected_selector;
    int16_t q[R5_SPATIAL_TAPS];
    R3_Counters fir;
    R4_Counters spatial;
} R5_Plan;

static int r5_selector_valid(uint8_t selector) {
    return selector == 0 || selector == 1 || selector == 2 || selector == 4 ||
           selector == 5 || selector == 6;
}

static int r5_selector_direction(uint8_t selector, unsigned *direction) {
    unsigned value = selector & 3u;
    if (value > 2u || (selector & 0xf8u) != 0 || !r5_selector_valid(selector)) return 0;
    *direction = value == 0 ? 0u : value - 1u;
    return 1;
}

static uint64_t r5_predictive_residuals(const R2_Frame *frame) {
    uint64_t count = 0;
    for (unsigned channel = 0; channel < 2; ++channel)
        if (r4_predictive(&frame->sub[channel])) count += frame->sub[channel].count;
    return count;
}

static int r5_has_predictive(const R2_Frame *frame) {
    return r5_predictive_residuals(frame) != 0;
}

static uint64_t r5_fir_updates(const R2_Frame *frame) {
    uint64_t updates = 0;
    for (unsigned channel = 0; channel < 2; ++channel)
        if (r4_predictive(&frame->sub[channel])) updates += frame->sub[channel].count / 4u;
    return updates;
}

static int r5_apply_spatial(R2_Frame *frame, uint8_t selector, const int16_t q[5],
                            int inverse, R4_Counters *counters) {
    unsigned direction;
    unsigned taps;
    int lags[5] = {0};
    if (!r5_selector_direction(selector, &direction)) return 0;
    if ((selector & 3u) == 0) return 1;
    if (!r4_profile(R5_SPATIAL_PROFILE, &taps, lags) || taps != R5_SPATIAL_TAPS) return 0;
    R4_Fit fit = {.valid = 1, .taps = taps};
    memcpy(fit.q, q, sizeof fit.q);
    memcpy(fit.lags, lags, sizeof fit.lags);
    if (!r4_eligible(&frame->sub[0]) || !r4_eligible(&frame->sub[1])) return 0;
    return r4_transform_subframe(&frame->sub[1u - direction], &frame->sub[direction],
                                 &fit, inverse, counters);
}

static int r5_frame_body(const R2_Frame *frame, uint8_t selector, const int16_t q[5],
                         R2_Model *model, uint8_t mode, R2_Bytes *body,
                         R2_Metrics *metrics) {
    uint8_t prefix[4] = {(uint8_t)frame->blocksize, (uint8_t)(frame->blocksize >> 8),
                         frame->assignment, selector};
    if (!r5_selector_valid(selector) || !r2_bytes_write(body, prefix, sizeof prefix)) return 0;
    if ((selector & 3u) != 0) {
        for (unsigned j = 0; j < R5_SPATIAL_TAPS; ++j) {
            uint16_t value = (uint16_t)q[j];
            uint8_t bytes[2] = {(uint8_t)value, (uint8_t)(value >> 8)};
            if (!r2_bytes_write(body, bytes, sizeof bytes)) return 0;
        }
    }
    return r2_encode_subframe(&frame->sub[0], model, mode, frame->assignment, 0, body, metrics) &&
           r2_encode_subframe(&frame->sub[1], model, mode, frame->assignment, 1, body, metrics) &&
           body->length <= R2_MAX_FRAME_BODY;
}

static int r5_rice_cost(const R2_Frame *frame, uint8_t selector, const int16_t q[5],
                        uint64_t *cost) {
    R2_Bytes body = {0};
    R2_Metrics metrics = {0};
    int ok = r5_frame_body(frame, selector, q, NULL, 0, &body, &metrics);
    if (ok && body.length > UINT64_MAX - 4u) ok = 0;
    if (ok) *cost = body.length + 4u;
    r2_bytes_free(&body);
    return ok;
}

static int r5_candidate_c(const R2_Frame *original, R5_Candidate *candidate) {
    memset(candidate, 0, sizeof *candidate);
    if (!r4_clone_frame(original, &candidate->frame)) return 0;
    R4_Plan spatial_plan;
    if (!r4_plan_frame(&candidate->frame, R5_SPATIAL_PROFILE, &spatial_plan,
                       &candidate->spatial) ||
        !r5_rice_cost(&candidate->frame, spatial_plan.selector, spatial_plan.q,
                      &candidate->rice_bytes)) {
        r2_free_frame(&candidate->frame);
        return 0;
    }
    candidate->selector = spatial_plan.selector;
    memcpy(candidate->q, spatial_plan.q, sizeof candidate->q);
    candidate->valid = 1;
    return 1;
}

static int r5_candidate_fir(const R2_Frame *original, const R5_Candidate *cheap,
                            int stacked, R5_Candidate *candidate) {
    memset(candidate, 0, sizeof *candidate);
    if (!r4_clone_frame(original, &candidate->frame)) return 0;
    if (stacked && (cheap->selector & 3u) != 0 &&
        !r5_apply_spatial(&candidate->frame, cheap->selector, cheap->q, 0,
                          &candidate->spatial)) {
        r2_free_frame(&candidate->frame);
        return 0;
    }
    if (!r3_prepare_frame(&candidate->frame, R5_FIR_PROFILE, &candidate->fir) ||
        !r5_rice_cost(&candidate->frame,
                      (uint8_t)(4u | (stacked ? (cheap->selector & 3u) : 0u)),
                      cheap->q, &candidate->rice_bytes)) {
        r2_free_frame(&candidate->frame);
        return 0;
    }
    candidate->selector = (uint8_t)(4u | (stacked ? (cheap->selector & 3u) : 0u));
    if (!stacked) memset(candidate->q, 0, sizeof candidate->q);
    else memcpy(candidate->q, cheap->q, sizeof candidate->q);
    candidate->valid = 1;
    return 1;
}

static void r5_candidate_free(R5_Candidate *candidate) {
    r2_free_frame(&candidate->frame);
    memset(candidate, 0, sizeof *candidate);
}

static R5_Candidate *r5_choose_candidate(R5_Candidate *cheap,
                                         R5_Candidate *temporal,
                                         R5_Candidate *stacked, uint8_t policy) {
    R5_Candidate *chosen = cheap;
    R5_Candidate *entropy = NULL;
    if (policy != 0 && temporal->valid) {
        entropy = temporal;
        if (stacked->valid && stacked->rice_bytes < temporal->rice_bytes) entropy = stacked;
    }
    uint64_t threshold = policy == 2 ? 32u : 0u;
    if (policy != 0 && entropy && cheap->rice_bytes > entropy->rice_bytes &&
        cheap->rice_bytes - entropy->rice_bytes > threshold) chosen = entropy;
    return chosen;
}

static int r5_plan_frame(R2_Frame *frame, uint8_t policy, R5_Plan *plan) {
    if (policy > R5_MAX_POLICY) return 0;
    memset(plan, 0, sizeof *plan);
    plan->temporal_rice_bytes = UINT64_MAX;
    plan->stacked_rice_bytes = UINT64_MAX;
    R2_Frame original = {0};
    if (!r4_clone_frame(frame, &original)) return 0;
    R5_Candidate cheap = {0}, temporal = {0}, stacked = {0};
    int ok = r5_candidate_c(&original, &cheap);
    if (!ok) goto fail;
    plan->cheap_rice_bytes = cheap.rice_bytes;
    if (policy != 0 && r5_has_predictive(&original)) {
        if (!r5_candidate_fir(&original, &cheap, 0, &temporal)) goto fail;
        plan->temporal_rice_bytes = temporal.rice_bytes;
        if ((cheap.selector & 3u) != 0) {
            if (!r5_candidate_fir(&original, &cheap, 1, &stacked)) goto fail;
            plan->stacked_rice_bytes = stacked.rice_bytes;
        } else {
            /* T and H are exactly the same when C has no spatial transform. */
            plan->stacked_rice_bytes = temporal.rice_bytes;
        }
    }
    R5_Candidate *chosen = r5_choose_candidate(&cheap, &temporal, &stacked, policy);
    plan->selected_rice_bytes = chosen->rice_bytes;
    plan->selected_selector = chosen->selector;
    memcpy(plan->q, chosen->q, sizeof plan->q);
    plan->fir = chosen->fir;
    plan->spatial = chosen->spatial;
    R2_Frame selected = chosen->frame;
    memset(&chosen->frame, 0, sizeof chosen->frame);
    r2_free_frame(frame);
    *frame = selected;
    r5_candidate_free(&cheap);
    r5_candidate_free(&temporal);
    r5_candidate_free(&stacked);
    r2_free_frame(&original);
    return 1;
fail:
    r5_candidate_free(&cheap);
    r5_candidate_free(&temporal);
    r5_candidate_free(&stacked);
    r2_free_frame(&original);
    return 0;
}

static void r5_note_selected(const R2_Frame *frame, const R5_Plan *plan,
                             R5_Counters *counters, int plan_row) {
    uint8_t selector = plan->selected_selector;
    unsigned direction = 0;
    (void)r5_selector_direction(selector, &direction);
    if (plan_row) counters->plan_rows++;
    counters->predictive_residuals += r5_predictive_residuals(frame);
    if (selector <= 2) counters->cheap_frames++;
    if (selector == 4) counters->temporal_frames++;
    if (selector == 5 || selector == 6) counters->stacked_frames++;
    if ((selector & 3u) != 0) {
        counters->spatial_frames++;
        counters->coefficient_bytes += R5_COEFFICIENT_BYTES;
        if (selector == 1 || selector == 5) counters->reference0_frames++;
        else if (selector == 2 || selector == 6) counters->reference1_frames++;
    }
    if ((selector & 4u) != 0) {
        counters->fir_frames++;
        counters->fir_residuals += r5_predictive_residuals(frame);
        counters->fir_updates += plan->fir.updates;
    }
    counters->fir_prediction_clamp += plan->fir.prediction_clamp;
    counters->fir_coefficient_clamp += plan->fir.coefficient_clamp;
    counters->fir_modular_wrap += plan->fir.modular_wrap;
    counters->spatial_prediction_clamp += plan->spatial.prediction_clamp;
    counters->spatial_modular_wrap += plan->spatial.modular_wrap;
}

static int r5_write_plan_header(FILE *file) {
    return fprintf(file,
                   "frameOrdinal,blockSize,cheapRiceBytes,temporalRiceBytes,"
                   "stackedRiceBytes,selectedRiceBytes,selectedSelector,"
                   "coefficientBytes,predictiveResiduals,firResiduals,firUpdates\n") > 0;
}

static int r5_write_plan_row(FILE *file, uint64_t ordinal, const R2_Frame *frame,
                             const R5_Plan *plan) {
    char temporal[32], stacked[32];
    if (plan->temporal_rice_bytes == UINT64_MAX) strcpy(temporal, "NA");
    else snprintf(temporal, sizeof temporal, "%" PRIu64, plan->temporal_rice_bytes);
    if (plan->stacked_rice_bytes == UINT64_MAX) strcpy(stacked, "NA");
    else snprintf(stacked, sizeof stacked, "%" PRIu64, plan->stacked_rice_bytes);
    uint64_t predictive = r5_predictive_residuals(frame);
    uint64_t fir = (plan->selected_selector & 4u) != 0 ? predictive : 0;
    uint64_t updates = (plan->selected_selector & 4u) != 0 ? r5_fir_updates(frame) : 0;
    return fprintf(file, "%" PRIu64 ",%u,%" PRIu64 ",%s,%s,%" PRIu64 ",%u,%u,%" PRIu64 ",%" PRIu64 ",%" PRIu64 "\n",
                   ordinal, frame->blocksize, plan->cheap_rice_bytes, temporal, stacked,
                   plan->selected_rice_bytes, plan->selected_selector,
                   (plan->selected_selector & 3u) != 0 ? R5_COEFFICIENT_BYTES : 0u,
                   predictive, fir, updates) > 0;
}

static int r5_write_header(FILE *output, uint8_t mode, uint8_t policy,
                           const R2_Rsd *input, const R2_Model *model) {
    if (!write_bytes(output, R5_MAGIC, 8) || !put_u8(output, mode) ||
        !put_u8(output, R5_SHAPE) || !put_u8(output, policy) ||
        !put_u8(output, R5_SPATIAL_PROFILE) || !put_u64(output, input->manifest_length) ||
        !put_u64(output, input->record_count) ||
        !put_u32(output, mode ? model->table_count : 0) ||
        !write_bytes(output, input->manifest, (size_t)input->manifest_length)) return 0;
    if (mode) {
        for (uint32_t i = 0; i < model->table_count; ++i) {
            const R2_Table *table = &model->tables[i];
            if (!put_u8(output, table->role) || !put_u8(output, table->k) ||
                !put_u8(output, table->context)) return 0;
            for (unsigned symbol = 0; symbol < 17; ++symbol)
                if (!put_u16(output, table->freq[symbol])) return 0;
        }
    }
    return 1;
}

static int r5_read_header(FILE *input, uint8_t *mode, uint8_t *policy,
                          uint8_t *spatial_profile, uint8_t **manifest,
                          uint64_t *manifest_length, uint64_t *record_count,
                          R2_Model *model) {
    char magic[8];
    uint8_t shape;
    uint32_t table_count;
    if (!read_bytes(input, magic, sizeof magic) || memcmp(magic, R5_MAGIC, 8) != 0 ||
        !get_u8(input, mode) || !get_u8(input, &shape) || !get_u8(input, policy) ||
        !get_u8(input, spatial_profile) || !get_u64(input, manifest_length) ||
        !get_u64(input, record_count) || !get_u32(input, &table_count) ||
        shape != R5_SHAPE || *mode > 1 || *policy > R5_MAX_POLICY ||
        *spatial_profile != R5_SPATIAL_PROFILE || *manifest_length > R2_MAX_MANIFEST ||
        table_count > R2_MAX_TABLES || (*mode == 0 && table_count != 0)) return 0;
    *manifest = malloc(*manifest_length ? (size_t)*manifest_length : 1u);
    if (!*manifest) return 0;
    if (!read_bytes(input, *manifest, (size_t)*manifest_length)) {
        free(*manifest);
        *manifest = NULL;
        return 0;
    }
    memset(model, 0, sizeof *model);
    for (unsigned role = 0; role < 4; ++role)
        for (unsigned k = 0; k < 31; ++k)
            for (unsigned context = 0; context < 5; ++context)
                model->index[role][k][context] = -1;
    model->table_count = table_count;
    uint8_t previous_role = 0, previous_k = 0, previous_context = 0;
    int has_previous = 0;
    for (uint32_t ti = 0; ti < table_count; ++ti) {
        R2_Table *table = &model->tables[ti];
        if (!get_u8(input, &table->role) || !get_u8(input, &table->k) ||
            !get_u8(input, &table->context) || table->role >= 4 || table->k >= 31 ||
            table->context >= 5 ||
            (has_previous && r2_table_key_compare(previous_role, previous_k, previous_context,
                                                   table->role, table->k, table->context) >= 0)) return 0;
        uint32_t sum = 0, cumulative = 0;
        for (unsigned symbol = 0; symbol < 17; ++symbol) {
            if (!get_u16(input, &table->freq[symbol])) return 0;
            sum += table->freq[symbol];
            table->cumulative[symbol] = (uint16_t)cumulative;
            for (uint32_t slot = 0; slot < table->freq[symbol]; ++slot) {
                if (cumulative + slot >= R2_SCALE) return 0;
                table->symbol[cumulative + slot] = (uint8_t)symbol;
            }
            cumulative += table->freq[symbol];
        }
        table->cumulative[17] = (uint16_t)cumulative;
        if (sum != R2_SCALE || cumulative != R2_SCALE ||
            model->index[table->role][table->k][table->context] >= 0) return 0;
        model->index[table->role][table->k][table->context] = (int16_t)ti;
        previous_role = table->role;
        previous_k = table->k;
        previous_context = table->context;
        has_previous = 1;
    }
    return 1;
}

static int r5_write_frame(const R2_Frame *frame, const R5_Plan *plan,
                          R2_Model *model, uint8_t mode, FILE *output,
                          R2_Metrics *metrics) {
    R2_Bytes body = {0};
    if (!r5_frame_body(frame, plan->selected_selector, plan->q, model, mode, &body, metrics) ||
        body.length > UINT32_MAX) {
        r2_bytes_free(&body);
        return 0;
    }
    uint8_t length[4] = {(uint8_t)body.length, (uint8_t)(body.length >> 8),
                         (uint8_t)(body.length >> 16), (uint8_t)(body.length >> 24)};
    int ok = write_bytes(output, length, sizeof length) && write_bytes(output, body.data, body.length);
    if (ok) {
        metrics->frame_count++;
        metrics->frame_bytes += body.length + 4u;
    }
    r2_bytes_free(&body);
    return ok;
}

static int r5_inverse_frame(R2_Frame *frame, const R5_Plan *plan,
                            R3_Counters *fir, R4_Counters *spatial) {
    if ((plan->selected_selector & 4u) != 0) {
        if (!r3_transform_subframe(&frame->sub[0], R5_FIR_PROFILE, 1, fir) ||
            !r3_transform_subframe(&frame->sub[1], R5_FIR_PROFILE, 1, fir)) return 0;
    }
    if ((plan->selected_selector & 3u) != 0 &&
        !r5_apply_spatial(frame, plan->selected_selector, plan->q, 1, spatial)) return 0;
    return 1;
}

static int r5_restore_pcm(const R2_Frame *frame, FILE *output) {
    int64_t *values[2] = {calloc(frame->blocksize, sizeof **values),
                          calloc(frame->blocksize, sizeof **values)};
    if (!values[0] || !values[1] ||
        !r2_restore_subframe(&frame->sub[0], frame->blocksize, frame->assignment, 0, values[0]) ||
        !r2_restore_subframe(&frame->sub[1], frame->blocksize, frame->assignment, 1, values[1])) {
        free(values[0]); free(values[1]);
        return 0;
    }
    for (uint32_t i = 0; i < frame->blocksize; ++i) {
        int64_t left, right;
        switch (frame->assignment) {
            case FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT:
                left = values[0][i]; right = values[1][i]; break;
            case FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE:
                left = values[0][i];
                if (!checked_i64((__int128)values[0][i] - values[1][i], &right)) goto fail;
                break;
            case FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE:
                right = values[1][i];
                if (!checked_i64((__int128)values[1][i] + values[0][i], &left)) goto fail;
                break;
            case FLAC__CHANNEL_ASSIGNMENT_MID_SIDE: {
                int64_t twice;
                if (!checked_i64(2 * (__int128)values[0][i] + (values[1][i] & 1), &twice) ||
                    !checked_i64((__int128)twice + values[1][i], &left) ||
                    !checked_i64((__int128)twice - values[1][i], &right)) goto fail;
                left /= 2; right /= 2;
                break;
            }
            default: goto fail;
        }
        if (!write_s24(output, left) || !write_s24(output, right)) goto fail;
    }
    free(values[0]); free(values[1]);
    return 1;
fail:
    free(values[0]); free(values[1]);
    return 0;
}

static int r5_write_summary(const char *path, uint8_t mode, uint8_t policy,
                            const R2_Model *model, const R2_Metrics *metrics,
                            const R5_Counters *counters, uint64_t file_bytes,
                            uint64_t original_audit_bytes, uint64_t manifest_bytes,
                            uint64_t input_records) {
    FILE *summary = fopen(path, "wb");
    if (!summary) return 0;
    uint64_t table_bytes = (uint64_t)model->table_count * 37u;
    int ok = fprintf(summary,
        "{\"format\":\"issue77-round5-summary-v1\",\"mode\":%u,\"policy\":%u,"
        "\"recordCount\":%" PRIu64 ",\"frameCount\":%" PRIu64 ","
        "\"predictiveSubframes\":%" PRIu64 ",\"manifestBytes\":%" PRIu64 ","
        "\"tableCount\":%u,\"tableBytes\":%" PRIu64 ",\"sideBytes\":%" PRIu64 ","
        "\"entropyBytes\":%" PRIu64 ",\"bypassBytes\":%" PRIu64 ","
        "\"frameBytes\":%" PRIu64 ",\"fileBytes\":%" PRIu64 ","
        "\"auditBytes\":%" PRIu64 ",\"originalAuditBytes\":%" PRIu64 ","
        "\"inputRecordCount\":%" PRIu64 ",\"coefficientBytes\":%" PRIu64 ","
        "\"planRows\":%" PRIu64 ",\"cheapFrames\":%" PRIu64 ","
        "\"temporalFrames\":%" PRIu64 ",\"stackedFrames\":%" PRIu64 ","
        "\"spatialFrames\":%" PRIu64 ",\"reference0Frames\":%" PRIu64 ","
        "\"reference1Frames\":%" PRIu64 ",\"firFrames\":%" PRIu64 ","
        "\"predictiveResiduals\":%" PRIu64 ",\"firResiduals\":%" PRIu64 ","
        "\"firUpdates\":%" PRIu64 ",\"firPredictionClamp\":%" PRIu64 ","
        "\"firCoefficientClamp\":%" PRIu64 ",\"firModularWrap\":%" PRIu64 ","
        "\"spatialPredictionClamp\":%" PRIu64 ",\"spatialModularWrap\":%" PRIu64 "}\n",
        mode, policy, metrics->record_count, metrics->frame_count,
        metrics->predictive_subframes, manifest_bytes, model->table_count, table_bytes,
        metrics->side_bytes, metrics->entropy_bytes, metrics->bypass_bytes,
        metrics->frame_bytes, file_bytes, metrics->audit_bytes, original_audit_bytes,
        input_records, counters->coefficient_bytes, counters->plan_rows,
        counters->cheap_frames, counters->temporal_frames, counters->stacked_frames,
        counters->spatial_frames, counters->reference0_frames, counters->reference1_frames,
        counters->fir_frames, counters->predictive_residuals, counters->fir_residuals,
        counters->fir_updates, counters->fir_prediction_clamp,
        counters->fir_coefficient_clamp, counters->fir_modular_wrap,
        counters->spatial_prediction_clamp, counters->spatial_modular_wrap);
    if (fclose(summary) != 0) ok = 0;
    return ok > 0;
}

static void r5_remove_path(const char *path) {
    if (strcmp(path, "-") != 0) remove(path);
}

static int r5_build_model(R2_Rsd *input, R2_Model *model, uint8_t policy) {
    memset(model, 0, sizeof *model);
    if (!r2_rewind_rsd(input)) return 0;
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input->record_count; ++index) {
        R2_Frame frame = {0};
        R5_Plan plan;
        if (!r2_read_rsd_frame(input->file, &frame) ||
            !r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) ||
            !r5_plan_frame(&frame, policy, &plan) ||
            !r2_subframe_hist(model, &frame.sub[0], frame.assignment, 0) ||
            !r2_subframe_hist(model, &frame.sub[1], frame.assignment, 1)) {
            r2_free_frame(&frame);
            return 0;
        }
        r2_free_frame(&frame);
    }
    int ch = fgetc(input->file);
    if (ch != EOF || ferror(input->file) || !r2_normalize_model(model)) return 0;
    return r2_rewind_rsd(input);
}

static int r5_encode(const char *input_path, const char *output_path,
                     const char *original_audit_path, const char *coded_audit_path,
                     const char *summary_path, uint8_t mode, uint8_t policy,
                     const char *plan_path) {
    R2_Rsd input;
    R2_Model model;
    FILE *output = NULL, *plan_file = NULL;
    R3_Audit original_audit = {0};
    R2_Audit coded_audit = {0};
    R2_Metrics metrics = {0};
    R5_Counters counters = {0};
    if (mode > 1 || policy > R5_MAX_POLICY || !r2_open_rsd(input_path, &input)) {
        r2_fail("cannot open round5 RSD input");
        return 2;
    }
    memset(&model, 0, sizeof model);
    if ((mode == 1 && !r5_build_model(&input, &model, policy)) ||
        (mode == 0 && !r2_rewind_rsd(&input))) {
        r2_fail("cannot build round5 model");
        r2_close_rsd(&input);
        return 2;
    }
    output = fopen(output_path, "wb");
    if (strcmp(plan_path, "-") != 0) plan_file = fopen(plan_path, "wb");
    if (!output || (strcmp(plan_path, "-") != 0 && !plan_file) ||
        !r5_write_header(output, mode, policy, &input, &model) ||
        (plan_file && !r5_write_plan_header(plan_file)) ||
        !r3_open_original_audit(original_audit_path, &original_audit) ||
        !r3_open_coded_audit(coded_audit_path, &coded_audit)) {
        r2_fail("cannot create round5 output");
        if (output) fclose(output);
        if (plan_file) fclose(plan_file);
        if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        r2_close_rsd(&input);
        remove(output_path);
        r5_remove_path(plan_path);
        r5_remove_path(original_audit_path);
        r5_remove_path(coded_audit_path);
        remove(summary_path);
        return 2;
    }
    uint64_t packed = 0, offset = 0;
    uint32_t chunk = 0;
    int has_previous = 0;
    for (uint64_t index = 0; index < input.record_count; ++index) {
        R2_Frame frame = {0}, before = {0}, restored = {0};
        R5_Plan plan;
        R3_Counters inverse_fir = {0};
        R4_Counters inverse_spatial = {0};
        int success = r2_read_rsd_frame(input.file, &frame) &&
                      r2_validate_sequence(&frame, index, &packed, &chunk, &offset, &has_previous) &&
                      r4_clone_frame(&frame, &before) &&
                      r5_plan_frame(&frame, policy, &plan) &&
                      r5_write_frame(&frame, &plan, &model, mode, output, &metrics) &&
                      r4_audit_coded_frame(&coded_audit, &frame, plan.selected_selector,
                                           plan.q, (plan.selected_selector & 3u) != 0 ? R5_SPATIAL_TAPS : 0) &&
                      r4_clone_frame(&frame, &restored) &&
                      r5_inverse_frame(&restored, &plan, &inverse_fir, &inverse_spatial) &&
                      r3_counters_equal(&plan.fir, &inverse_fir) &&
                      r4_counters_equal_path(&plan.spatial, &inverse_spatial) &&
                      (!(plan.selected_selector & 4u) ||
                       plan.fir.updates == r5_fir_updates(&frame)) &&
                      restored.sub[0].count == before.sub[0].count &&
                      restored.sub[1].count == before.sub[1].count &&
                      memcmp(restored.sub[0].data, before.sub[0].data,
                             before.sub[0].count * sizeof *before.sub[0].data) == 0 &&
                      memcmp(restored.sub[1].data, before.sub[1].data,
                             before.sub[1].count * sizeof *before.sub[1].data) == 0 &&
                      r3_audit_original_frame(&original_audit, &restored) &&
                      (!plan_file || r5_write_plan_row(plan_file, index, &frame, &plan));
        if (!success) {
            r2_fail("RSD frame rejected during round5 encoding");
            r2_free_frame(&frame); r2_free_frame(&before); r2_free_frame(&restored);
            fclose(output); if (plan_file) fclose(plan_file);
            if (original_audit.file) fclose(original_audit.file);
            if (coded_audit.file) fclose(coded_audit.file);
            r2_close_rsd(&input); remove(output_path); r5_remove_path(original_audit_path);
            r5_remove_path(coded_audit_path); remove(summary_path); r5_remove_path(plan_path);
            return 2;
        }
        r5_note_selected(&frame, &plan, &counters, 1);
        r2_free_frame(&frame); r2_free_frame(&before); r2_free_frame(&restored);
        metrics.record_count++;
    }
    if (fgetc(input.file) != EOF || ferror(input.file) || fflush(output) != 0 ||
        (plan_file && fflush(plan_file) != 0) ||
        (original_audit.file && fflush(original_audit.file) != 0) ||
        (coded_audit.file && fflush(coded_audit.file) != 0)) {
        r2_fail("RSD has trailing bytes or round5 output flush failed");
        fclose(output); if (plan_file) fclose(plan_file);
        if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        r2_close_rsd(&input); remove(output_path); r5_remove_path(original_audit_path);
        r5_remove_path(coded_audit_path); remove(summary_path); r5_remove_path(plan_path); return 2;
    }
    metrics.audit_bytes = coded_audit.bytes;
    off_t end = ftello(output);
    int ok = end >= 0 && fclose(output) == 0 && (!plan_file || fclose(plan_file) == 0) &&
             (!original_audit.file || fclose(original_audit.file) == 0) &&
             (!coded_audit.file || fclose(coded_audit.file) == 0) &&
             r5_write_summary(summary_path, mode, policy, &model, &metrics, &counters,
                              (uint64_t)end, original_audit.bytes, input.manifest_length,
                              input.record_count);
    r2_close_rsd(&input);
    if (!ok) {
        remove(output_path); r5_remove_path(original_audit_path); r5_remove_path(coded_audit_path);
        remove(summary_path); r5_remove_path(plan_path); return 2;
    }
    return 0;
}

static int r5_decode_frame(const uint8_t *body, size_t body_length, uint8_t mode,
                           uint8_t policy, R2_Model *model, FILE *output,
                           R3_Audit *original_audit, R2_Audit *coded_audit,
                           R2_Metrics *metrics, R5_Counters *counters) {
    R2_Cursor cursor = {.data = (uint8_t *)body, .length = body_length};
    uint16_t blocksize;
    uint8_t assignment, selector;
    if (!r2_cursor_u16(&cursor, &blocksize) || !r2_cursor_u8(&cursor, &assignment) ||
        !r2_cursor_u8(&cursor, &selector) || blocksize == 0 || assignment > 3 ||
        !r5_selector_valid(selector) || (policy == 0 && (selector & 4u) != 0)) return 0;
    R5_Plan plan = {.selected_selector = selector};
    if ((selector & 3u) != 0) {
        for (unsigned j = 0; j < R5_SPATIAL_TAPS; ++j) {
            uint16_t raw;
            if (!r2_cursor_u16(&cursor, &raw)) return 0;
            int32_t signed_raw = raw < UINT16_C(0x8000) ? (int32_t)raw :
                                 (int32_t)raw - INT32_C(65536);
            if (signed_raw < -R4_COEFF_LIMIT || signed_raw > R4_COEFF_LIMIT)
                return 0;
            plan.q[j] = (int16_t)signed_raw;
        }
        int any = 0;
        for (unsigned j = 0; j < R5_SPATIAL_TAPS; ++j) if (plan.q[j] != 0) any = 1;
        if (!any) return 0;
    }
    R2_Frame frame = {.blocksize = blocksize, .assignment = assignment};
    size_t position = cursor.position;
    for (unsigned channel = 0; channel < 2; ++channel) {
        size_t side_bytes;
        uint32_t entropy_bytes, bypass_bytes;
        if (!r2_decode_side_subframe(body, body_length, &position, blocksize, assignment,
                                     channel, mode, model, &frame.sub[channel], &side_bytes,
                                     &entropy_bytes, &bypass_bytes) ||
            !r3_validate_coded_subframe(&frame.sub[channel])) {
            r2_free_frame(&frame); return 0;
        }
        metrics->side_bytes += side_bytes;
        if (r4_predictive(&frame.sub[channel])) {
            metrics->predictive_subframes++;
            metrics->entropy_bytes += entropy_bytes;
            metrics->bypass_bytes += bypass_bytes;
        }
    }
    if ((selector & 3u) != 0 && (!r4_eligible(&frame.sub[0]) || !r4_eligible(&frame.sub[1]))) {
        r2_free_frame(&frame); return 0;
    }
    if ((selector & 4u) != 0 && !r5_has_predictive(&frame)) {
        r2_free_frame(&frame); return 0;
    }
    if ((selector & 4u) != 0) plan.fir.updates = r5_fir_updates(&frame);
    if (position != body_length ||
        !r4_audit_coded_frame(coded_audit, &frame, selector, plan.q,
                              (selector & 3u) != 0 ? R5_SPATIAL_TAPS : 0)) {
        r2_free_frame(&frame); return 0;
    }
    r5_note_selected(&frame, &plan, counters, 0);
    R3_Counters fir = {0};
    R4_Counters spatial = {0};
    if (!r5_inverse_frame(&frame, &plan, &fir, &spatial) ||
        fir.updates != plan.fir.updates ||
        !r3_audit_original_frame(original_audit, &frame) ||
        !r5_restore_pcm(&frame, output)) {
        r2_free_frame(&frame); return 0;
    }
    counters->fir_prediction_clamp += fir.prediction_clamp;
    counters->fir_coefficient_clamp += fir.coefficient_clamp;
    counters->fir_modular_wrap += fir.modular_wrap;
    counters->spatial_prediction_clamp += spatial.prediction_clamp;
    counters->spatial_modular_wrap += spatial.modular_wrap;
    metrics->frame_count++;
    metrics->frame_bytes += body_length + 4u;
    r2_free_frame(&frame);
    return 1;
}

static int r5_decode(const char *input_path, const char *output_path,
                     const char *original_audit_path, const char *coded_audit_path,
                     const char *summary_path) {
    FILE *input = fopen(input_path, "rb"), *output = NULL;
    R3_Audit original_audit = {0};
    R2_Audit coded_audit = {0};
    R2_Model model;
    uint8_t mode, policy, spatial_profile, *manifest = NULL;
    uint64_t manifest_length, record_count;
    R2_Metrics metrics = {0};
    R5_Counters counters = {0};
    if (!input || !r5_read_header(input, &mode, &policy, &spatial_profile, &manifest,
                                  &manifest_length, &record_count, &model)) {
        r2_fail("invalid round5 header or model table");
        if (input) fclose(input);
        free(manifest);
        return 2;
    }
    output = fopen(output_path, "wb");
    if (!output || !r3_open_original_audit(original_audit_path, &original_audit) ||
        !r3_open_coded_audit(coded_audit_path, &coded_audit)) {
        r2_fail("cannot create round5 decoded outputs");
        if (output) fclose(output);
        if (original_audit.file) fclose(original_audit.file);
        if (coded_audit.file) fclose(coded_audit.file);
        fclose(input);
        free(manifest);
        remove(output_path);
        r5_remove_path(original_audit_path);
        r5_remove_path(coded_audit_path);
        remove(summary_path);
        return 2;
    }
    for (uint64_t index = 0; index < record_count; ++index) {
        uint32_t body_bytes;
        if (!get_u32(input, &body_bytes) || body_bytes == 0 || body_bytes > R2_MAX_FRAME_BODY) {
            r2_fail("invalid round5 frame length"); goto fail;
        }
        uint8_t *body = malloc(body_bytes);
        if (!body || !read_bytes(input, body, body_bytes)) {
            free(body); r2_fail("truncated round5 frame"); goto fail;
        }
        int ok = r5_decode_frame(body, body_bytes, mode, policy, &model, output,
                                 &original_audit, &coded_audit, &metrics, &counters);
        free(body);
        if (!ok) { r2_fail("round5 frame failed validation"); goto fail; }
        metrics.record_count++;
    }
    if (fgetc(input) != EOF || ferror(input) || fflush(output) != 0 ||
        (original_audit.file && fflush(original_audit.file) != 0) ||
        (coded_audit.file && fflush(coded_audit.file) != 0)) {
        r2_fail("round5 trailing bytes or output flush failed"); goto fail;
    }
    metrics.audit_bytes = coded_audit.bytes;
    off_t output_bytes = ftello(output), input_bytes = ftello(input);
    int ok = output_bytes >= 0 && input_bytes >= 0 && fclose(output) == 0 &&
             (!original_audit.file || fclose(original_audit.file) == 0) &&
             (!coded_audit.file || fclose(coded_audit.file) == 0) && fclose(input) == 0 &&
             r5_write_summary(summary_path, mode, policy, &model, &metrics, &counters,
                              (uint64_t)input_bytes, original_audit.bytes,
                              manifest_length, record_count);
    free(manifest);
    if (!ok) {
        remove(output_path);
        r5_remove_path(original_audit_path);
        r5_remove_path(coded_audit_path);
        remove(summary_path);
        return 2;
    }
    return 0;
fail:
    fclose(output); if (original_audit.file) fclose(original_audit.file);
    if (coded_audit.file) fclose(coded_audit.file);
    fclose(input); free(manifest); remove(output_path);
    r5_remove_path(original_audit_path); r5_remove_path(coded_audit_path);
    remove(summary_path); return 2;
}

#ifndef I77_ROUND5_NO_MAIN
static void r5_usage(const char *program) {
    fprintf(stderr,
            "usage:\n  %s encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE(0|1) POLICY(0..2) PLAN_CSV\n"
            "  %s decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY\n", program, program);
}

int main(int argc, char **argv) {
    if (argc == 10 && strcmp(argv[1], "encode") == 0) {
        char *end_mode = NULL, *end_policy = NULL;
        unsigned long mode = strtoul(argv[7], &end_mode, 10);
        unsigned long policy = strtoul(argv[8], &end_policy, 10);
        if (!end_mode || *end_mode != '\0' || mode > 1 || !end_policy ||
            *end_policy != '\0' || policy > R5_MAX_POLICY) return 2;
        return r5_encode(argv[2], argv[3], argv[4], argv[5], argv[6],
                         (uint8_t)mode, (uint8_t)policy, argv[9]);
    }
    if (argc == 7 && strcmp(argv[1], "decode") == 0)
        return r5_decode(argv[2], argv[3], argv[4], argv[5], argv[6]);
    r5_usage(argv[0]);
    return 2;
}
#endif

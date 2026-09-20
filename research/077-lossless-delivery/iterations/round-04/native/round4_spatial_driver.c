/* Independent small-fixture driver for round 4 spatial math and selection. */
#define I77_ROUND4_NO_MAIN
#include "round4.c"
#undef I77_ROUND4_NO_MAIN

#include <errno.h>

static void die(const char *message) {
    fprintf(stderr, "round4 spatial driver: %s\n", message);
    exit(2);
}

static uint32_t arg_u32(const char *text) {
    char *end = NULL;
    unsigned long value = strtoul(text, &end, 10);
    if (!text[0] || !end || *end != '\0' || value > UINT32_MAX) die("bad unsigned argument");
    return (uint32_t)value;
}

static int32_t arg_i32(const char *text) {
    char *end = NULL;
    long long value = strtoll(text, &end, 10);
    if (!text[0] || !end || *end != '\0' || value < INT32_MIN || value > INT32_MAX)
        die("bad signed argument");
    return (int32_t)value;
}

static int16_t arg_i16(const char *text) {
    char *end = NULL;
    long value = strtol(text, &end, 10);
    if (!text[0] || !end || *end != '\0' || value < INT16_MIN || value > INT16_MAX)
        die("bad coefficient argument");
    return (int16_t)value;
}

static void json_i32_array(const int32_t *values, uint32_t count) {
    putchar('[');
    for (uint32_t i = 0; i < count; ++i) printf("%s%d", i ? "," : "", values[i]);
    putchar(']');
}

static void json_i16_array(const int16_t *values, unsigned count) {
    putchar('[');
    for (unsigned i = 0; i < count; ++i) printf("%s%d", i ? "," : "", values[i]);
    putchar(']');
}

static void init_sub(R2_Subframe *sub, uint32_t count, uint8_t order,
                     uint8_t partition_order, char **values) {
    memset(sub, 0, sizeof *sub);
    sub->type = FLAC__SUBFRAME_TYPE_FIXED;
    sub->order = order;
    sub->precision = 32;
    sub->shift = 0;
    sub->method = FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2;
    sub->partition_order = partition_order;
    sub->partition_count = 1u << partition_order;
    sub->count = count;
    sub->data = calloc(count ? count : 1u, sizeof *sub->data);
    if (!sub->data) die("allocation failed");
    for (uint32_t i = 0; i < count; ++i) sub->data[i] = arg_i32(values[i]);
}

static void free_subs(R2_Subframe *left, R2_Subframe *right) {
    free(left->data);
    free(right->data);
    left->data = NULL;
    right->data = NULL;
}

static void make_frame(R2_Frame *frame, uint32_t left_count, uint32_t right_count,
                       uint8_t order, uint8_t partition_order, char **values) {
    memset(frame, 0, sizeof *frame);
    frame->blocksize = (uint16_t)(left_count + order);
    frame->assignment = FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT;
    init_sub(&frame->sub[0], left_count, order, partition_order, values);
    init_sub(&frame->sub[1], right_count, order, partition_order, values + left_count);
    if (left_count != right_count) die("frame fixture requires equal residual counts");
}

static int clone_fixture(const R2_Frame *source, R2_Frame *copy) {
    return r4_clone_frame(source, copy);
}

static int serialize_rice(const R2_Frame *frame, const R4_Plan *plan, uint64_t *bytes) {
    FILE *file = tmpfile();
    if (!file) return 0;
    R2_Model model;
    memset(&model, 0, sizeof model);
    R2_Metrics metrics;
    memset(&metrics, 0, sizeof metrics);
    int ok = r4_encode_frame(frame, plan, &model, 0, file, &metrics);
    if (ok && fflush(file) == 0 && fseeko(file, 0, SEEK_END) == 0) {
        off_t end = ftello(file);
        ok = end >= 0;
        if (ok) *bytes = (uint64_t)end;
    } else ok = 0;
    fclose(file);
    return ok;
}

static int serialize_r2_rice(const R2_Frame *frame, uint64_t *bytes,
                             uint8_t **contents, size_t *content_length) {
    FILE *file = tmpfile();
    if (!file) return 0;
    R2_Model model;
    memset(&model, 0, sizeof model);
    R2_Metrics metrics;
    memset(&metrics, 0, sizeof metrics);
    int ok = r2_encode_frame(frame, &model, 0, file, &metrics);
    if (ok && fflush(file) == 0 && fseeko(file, 0, SEEK_END) == 0) {
        off_t end = ftello(file);
        ok = end >= 0 && (uintmax_t)end <= SIZE_MAX;
        if (ok) {
            *content_length = (size_t)end;
            *contents = malloc(*content_length ? *content_length : 1u);
            ok = *contents != NULL && fseeko(file, 0, SEEK_SET) == 0 &&
                 fread(*contents, 1, *content_length, file) == *content_length;
        }
    } else ok = 0;
    fclose(file);
    if (!ok) {
        free(*contents);
        *contents = NULL;
        *content_length = 0;
        return 0;
    }
    *bytes = (uint64_t)*content_length;
    return 1;
}

static int serialize_r4_rice(const R2_Frame *frame, const R4_Plan *plan,
                             uint64_t *bytes, uint8_t **contents,
                             size_t *content_length) {
    FILE *file = tmpfile();
    if (!file) return 0;
    R2_Model model;
    memset(&model, 0, sizeof model);
    R2_Metrics metrics;
    memset(&metrics, 0, sizeof metrics);
    int ok = r4_encode_frame(frame, plan, &model, 0, file, &metrics);
    if (ok && fflush(file) == 0 && fseeko(file, 0, SEEK_END) == 0) {
        off_t end = ftello(file);
        ok = end >= 0 && (uintmax_t)end <= SIZE_MAX;
        if (ok) {
            *content_length = (size_t)end;
            *contents = malloc(*content_length ? *content_length : 1u);
            ok = *contents != NULL && fseeko(file, 0, SEEK_SET) == 0 &&
                 fread(*contents, 1, *content_length, file) == *content_length;
        }
    } else ok = 0;
    fclose(file);
    if (!ok) {
        free(*contents);
        *contents = NULL;
        *content_length = 0;
        return 0;
    }
    *bytes = (uint64_t)*content_length;
    return 1;
}

static int candidate(const R2_Frame *source, unsigned taps, const int lags[5],
                     unsigned direction, R4_Plan *plan, uint64_t *score,
                     uint64_t *serialized) {
    R4_Fit fit;
    if (!r4_fit(&source->sub[direction], &source->sub[1u - direction], taps, lags, &fit) ||
        !fit.valid || fit.failure) return 0;
    R2_Frame frame = {0};
    if (!clone_fixture(source, &frame)) return 0;
    if (!r4_transform_subframe(&frame.sub[1u - direction], &frame.sub[direction],
                              &fit, 0, NULL) || !r4_score_frame(&frame, score)) {
        r2_free_frame(&frame);
        return 0;
    }
    if (UINT64_MAX - *score < (uint64_t)2u * taps) {
        r2_free_frame(&frame);
        return 0;
    }
    memset(plan, 0, sizeof *plan);
    plan->selector = (uint8_t)(direction + 1u);
    plan->taps = taps;
    memcpy(plan->q, fit.q, sizeof plan->q);
    plan->rice_bytes = *score + (uint64_t)2u * taps;
    int ok = serialize_rice(&frame, plan, serialized);
    r2_free_frame(&frame);
    return ok;
}

static void command_profile(int argc, char **argv) {
    if (argc != 3) die("profile expects profile id");
    unsigned taps = 0;
    int lags[5] = {0};
    int valid = r4_profile((uint8_t)arg_u32(argv[2]), &taps, lags);
    printf("{\"valid\":%d,\"taps\":%u,\"lags\":[", valid, taps);
    for (unsigned i = 0; i < taps; ++i) printf("%s%d", i ? "," : "", lags[i]);
    puts("]}");
}

static void command_floor(int argc, char **argv) {
    if (argc < 3) die("floor expects values");
    printf("{\"values\":[");
    for (int i = 2; i < argc; ++i) {
        int64_t value = strtoll(argv[i], NULL, 10);
        printf("%s%" PRId64, i == 2 ? "" : ",", r4_floor_q12(value));
    }
    puts("]}");
}

static void command_feature(int argc, char **argv) {
    if (argc < 8) die("feature arguments are incomplete");
    uint8_t reference_order = (uint8_t)arg_u32(argv[2]);
    uint32_t reference_count = arg_u32(argv[3]);
    uint8_t target_order = (uint8_t)arg_u32(argv[4]);
    uint32_t target_count = arg_u32(argv[5]);
    int lag = (int)arg_i32(argv[6]);
    uint32_t index = arg_u32(argv[7]);
    if (argc != 8 + (int)reference_count + (int)target_count) die("feature length mismatch");
    R2_Subframe reference = {0}, target = {0};
    init_sub(&reference, reference_count, reference_order, 0, argv + 8);
    init_sub(&target, target_count, target_order, 0, argv + 8 + reference_count);
    int32_t value = 0;
    int valid = r4_feature(&reference, &target, lag, index, &value);
    printf("{\"valid\":%d,\"value\":%d}\n", valid, value);
    free_subs(&reference, &target);
}

static void command_transform(int argc, char **argv) {
    if (argc < 7) die("transform arguments are incomplete");
    uint8_t profile = (uint8_t)arg_u32(argv[2]);
    unsigned taps = arg_u32(argv[3]);
    if (taps > 5 || argc < 4 + (int)(2u * taps) + 4) die("transform tap arguments invalid");
    int lags[5] = {0};
    int16_t q[5] = {0};
    int at = 4;
    for (unsigned j = 0; j < taps; ++j) lags[j] = (int)arg_i32(argv[at++]);
    for (unsigned j = 0; j < taps; ++j) q[j] = arg_i16(argv[at++]);
    uint8_t reference_order = (uint8_t)arg_u32(argv[at++]);
    uint32_t reference_count = arg_u32(argv[at++]);
    uint8_t target_order = (uint8_t)arg_u32(argv[at++]);
    uint32_t target_count = arg_u32(argv[at++]);
    if (argc != at + (int)reference_count + (int)target_count) die("transform length mismatch");
    R2_Subframe reference = {0}, target = {0};
    init_sub(&reference, reference_count, reference_order, 0, argv + at);
    at += (int)reference_count;
    init_sub(&target, target_count, target_order, 0, argv + at);
    R4_Fit fit = {.valid = 1, .taps = taps};
    memcpy(fit.lags, lags, sizeof fit.lags);
    memcpy(fit.q, q, sizeof fit.q);
    R4_Counters forward = {0}, inverse = {0};
    if (!r4_transform_subframe(&target, &reference, &fit, 0, &forward)) die("forward transform failed");
    printf("{\"profile\":%u,\"encoded\":", profile);
    json_i32_array(target.data, target.count);
    if (!r4_transform_subframe(&target, &reference, &fit, 1, &inverse)) die("inverse transform failed");
    printf(",\"recovered\":");
    json_i32_array(target.data, target.count);
    printf(",\"forwardCounters\":{\"predictionClamp\":%" PRIu64
           ",\"modularWrap\":%" PRIu64 "},\"inverseCounters\":{\"predictionClamp\":%" PRIu64
           ",\"modularWrap\":%" PRIu64 "}}\n", forward.prediction_clamp,
           forward.modular_wrap, inverse.prediction_clamp, inverse.modular_wrap);
    free_subs(&reference, &target);
}

static void command_fit(int argc, char **argv) {
    if (argc < 7) die("fit arguments are incomplete");
    uint8_t profile = (uint8_t)arg_u32(argv[2]);
    unsigned taps;
    int lags[5] = {0};
    if (!r4_profile(profile, &taps, lags)) die("invalid profile");
    uint8_t reference_order = (uint8_t)arg_u32(argv[3]);
    uint32_t reference_count = arg_u32(argv[4]);
    uint8_t target_order = (uint8_t)arg_u32(argv[5]);
    uint32_t target_count = arg_u32(argv[6]);
    int at = 7;
    if (argc != at + (int)reference_count + (int)target_count) die("fit length mismatch");
    R2_Subframe reference = {0}, target = {0};
    init_sub(&reference, reference_count, reference_order, 0, argv + at);
    at += (int)reference_count;
    init_sub(&target, target_count, target_order, 0, argv + at);
    R4_Fit fit;
    if (!r4_fit(&reference, &target, taps, lags, &fit)) die("fit failed");
    printf("{\"profile\":%u,\"taps\":%u,\"lags\":[", profile, taps);
    for (unsigned j = 0; j < taps; ++j) printf("%s%d", j ? "," : "", lags[j]);
    printf("],\"valid\":%d,\"degenerate\":%d,\"failure\":%d,\"clipped\":%u,\"q\":",
           fit.valid, fit.degenerate, fit.failure, fit.clipped);
    json_i16_array(fit.q, taps);
    puts("}");
    free_subs(&reference, &target);
}

static void command_score(int argc, char **argv) {
    if (argc < 5) die("score arguments are incomplete");
    uint8_t order = (uint8_t)arg_u32(argv[2]);
    uint8_t partition_order = (uint8_t)arg_u32(argv[3]);
    uint32_t count = arg_u32(argv[4]);
    if (argc != 5 + (int)(2u * count)) die("score length mismatch");
    R2_Frame frame = {0};
    make_frame(&frame, count, count, order, partition_order, argv + 5);
    uint64_t left = 0, right = 0, score = 0;
    if (!r3_choose_k(&frame.sub[0]) || !r3_choose_k(&frame.sub[1]) ||
        !r4_rice_bytes_sub(&frame.sub[0], &left) || !r4_rice_bytes_sub(&frame.sub[1], &right) ||
        !r4_score_frame(&frame, &score)) die("score failed");
    printf("{\"score\":%" PRIu64 ",\"leftBytes\":%" PRIu64 ",\"rightBytes\":%" PRIu64
           ",\"leftK\":%u,\"rightK\":%u}\n", score, left, right,
           frame.sub[0].parameters[0], frame.sub[1].parameters[0]);
    r2_free_frame(&frame);
}

static void command_choices(int argc, char **argv) {
    if (argc < 7) die("choices arguments are incomplete");
    uint8_t profile = (uint8_t)arg_u32(argv[2]);
    uint8_t order = (uint8_t)arg_u32(argv[3]);
    uint8_t partition_order = (uint8_t)arg_u32(argv[4]);
    uint32_t count = arg_u32(argv[5]);
    if (argc != 6 + (int)(2u * count)) die("choices length mismatch");
    R2_Frame source = {0};
    make_frame(&source, count, count, order, partition_order, argv + 6);
    unsigned taps;
    int lags[5] = {0};
    if (!r4_profile(profile, &taps, lags)) die("invalid profile");
    R2_Frame disabled = {0};
    if (!clone_fixture(&source, &disabled)) die("clone failed");
    uint64_t disabled_score = 0, disabled_bytes = 0;
    R4_Plan disabled_plan = {0};
    if (!r4_score_frame(&disabled, &disabled_score) || !serialize_rice(&disabled, &disabled_plan, &disabled_bytes))
        die("disabled serialization failed");
    printf("{\"profile\":%u,\"taps\":%u,\"disabled\":{\"score\":%" PRIu64
           ",\"serializedBytes\":%" PRIu64 "},\"directions\":[", profile, taps,
           disabled_score, disabled_bytes);
    r2_free_frame(&disabled);
    for (unsigned direction = 0; direction < 2; ++direction) {
        if (direction) putchar(',');
        R4_Plan plan = {0};
        uint64_t score = 0, bytes = 0;
        int valid = candidate(&source, taps, lags, direction, &plan, &score, &bytes);
        printf("{\"direction\":%u,\"valid\":%d", direction, valid);
        if (valid) {
            printf(",\"score\":%" PRIu64 ",\"chargedScore\":%" PRIu64
                   ",\"serializedBytes\":%" PRIu64 ",\"q\":", score,
                   plan.rice_bytes, bytes);
            json_i16_array(plan.q, taps);
        }
        putchar('}');
    }
    puts("]}");
    r2_free_frame(&source);
}

static void command_plan(int argc, char **argv) {
    if (argc < 6) die("plan arguments are incomplete");
    uint8_t profile = (uint8_t)arg_u32(argv[2]);
    uint8_t order = (uint8_t)arg_u32(argv[3]);
    uint8_t partition_order = (uint8_t)arg_u32(argv[4]);
    uint32_t count = arg_u32(argv[5]);
    if (argc != 6 + (int)(2u * count)) die("plan length mismatch");
    R2_Frame frame = {0};
    make_frame(&frame, count, count, order, partition_order, argv + 6);
    R4_Plan plan;
    R4_Counters counters = {0};
    if (!r4_plan_frame(&frame, profile, &plan, &counters)) die("plan failed");
    printf("{\"profile\":%u,\"selector\":%u,\"taps\":%u,\"riceBytes\":%" PRIu64
           ",\"q\":", profile, plan.selector, plan.taps, plan.rice_bytes);
    json_i16_array(plan.q, plan.taps);
    printf(",\"counters\":{\"disabled\":%" PRIu64 ",\"reference0\":%" PRIu64
           ",\"reference1\":%" PRIu64 ",\"coefficientBytes\":%" PRIu64
           ",\"predictionClamp\":%" PRIu64 ",\"modularWrap\":%" PRIu64
           ",\"fitDegenerate\":%" PRIu64 ",\"fitFailures\":%" PRIu64
           ",\"coefficientClipping\":%" PRIu64 "}}\n", counters.disabled_frames,
           counters.reference0_frames, counters.reference1_frames, counters.coefficient_bytes,
           counters.prediction_clamp, counters.modular_wrap, counters.fit_degenerate,
           counters.fit_failures, counters.coefficient_clipping);
    r2_free_frame(&frame);
}

static void command_disabled_compare(int argc, char **argv) {
    if (argc < 5) die("disabled_compare arguments are incomplete");
    uint8_t order = (uint8_t)arg_u32(argv[2]);
    uint8_t partition_order = (uint8_t)arg_u32(argv[3]);
    uint32_t count = arg_u32(argv[4]);
    if (argc != 5 + (int)(2u * count)) die("disabled_compare length mismatch");
    R2_Frame round2 = {0}, round4 = {0};
    make_frame(&round2, count, count, order, partition_order, argv + 5);
    if (!clone_fixture(&round2, &round4)) die("disabled_compare clone failed");
    R3_Counters r3_counters = {0};
    R4_Plan plan = {0};
    R4_Counters r4_counters = {0};
    if (!r3_prepare_frame(&round2, 0, &r3_counters) ||
        !r4_plan_frame(&round4, 0, &plan, &r4_counters)) {
        r2_free_frame(&round2); r2_free_frame(&round4); die("disabled_compare prepare failed");
    }
    uint8_t *old_bytes = NULL, *new_bytes = NULL;
    size_t old_length = 0, new_length = 0;
    uint64_t old_count = 0, new_count = 0;
    if (!serialize_r2_rice(&round2, &old_count, &old_bytes, &old_length) ||
        !serialize_r4_rice(&round4, &plan, &new_count, &new_bytes, &new_length)) {
        free(old_bytes); free(new_bytes); r2_free_frame(&round2); r2_free_frame(&round4);
        die("disabled_compare serialization failed");
    }
    int equal = old_length == new_length && memcmp(old_bytes, new_bytes, old_length) == 0;
    printf("{\"equal\":%d,\"round2Bytes\":%" PRIu64 ",\"round4Bytes\":%" PRIu64
           ",\"round4Selector\":%u}\n", equal, old_count, new_count, plan.selector);
    free(old_bytes); free(new_bytes);
    r2_free_frame(&round2); r2_free_frame(&round4);
    if (!equal) exit(1);
}

int main(int argc, char **argv) {
    if (argc < 2) die("missing command");
    if (strcmp(argv[1], "profile") == 0) command_profile(argc, argv);
    else if (strcmp(argv[1], "floor") == 0) command_floor(argc, argv);
    else if (strcmp(argv[1], "feature") == 0) command_feature(argc, argv);
    else if (strcmp(argv[1], "transform") == 0) command_transform(argc, argv);
    else if (strcmp(argv[1], "fit") == 0) command_fit(argc, argv);
    else if (strcmp(argv[1], "score") == 0) command_score(argc, argv);
    else if (strcmp(argv[1], "choices") == 0) command_choices(argc, argv);
    else if (strcmp(argv[1], "plan") == 0) command_plan(argc, argv);
    else if (strcmp(argv[1], "disabled_compare") == 0) command_disabled_compare(argc, argv);
    else die("unknown command");
    return 0;
}

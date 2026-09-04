#include <stddef.h>
#include <stdint.h>

extern unsigned char __heap_base;
static uintptr_t heap_next;

void *malloc(size_t bytes) {
    uintptr_t start;
    uintptr_t end;
    if (heap_next == 0) heap_next = (uintptr_t)&__heap_base;
    start = (heap_next + 15u + sizeof(size_t)) & ~(uintptr_t)15u;
    if (bytes > (size_t)(2u * 1024u * 1024u) || start > 2u * 1024u * 1024u - bytes) return NULL;
    end = start + bytes;
    heap_next = end;
    ((size_t *)start)[-1] = bytes;
    return (void *)start;
}

void free(void *pointer) { (void)pointer; }

void *realloc(void *pointer, size_t bytes) {
    unsigned char *result;
    size_t old_bytes;
    size_t copied;
    size_t index;
    if (pointer == NULL) return malloc(bytes);
    if (bytes == 0) return NULL;
    old_bytes = ((size_t *)pointer)[-1];
    result = malloc(bytes);
    if (result == NULL) return NULL;
    copied = old_bytes < bytes ? old_bytes : bytes;
    for (index = 0; index < copied; index++) result[index] = ((unsigned char *)pointer)[index];
    return result;
}

void *calloc(size_t count, size_t bytes) {
    size_t total;
    unsigned char *result;
    size_t index;
    if (count != 0 && bytes > (size_t)-1 / count) return NULL;
    total = count * bytes;
    result = malloc(total);
    if (result == NULL) return NULL;
    for (index = 0; index < total; index++) result[index] = 0;
    return result;
}

void *memcpy(void *destination, const void *source, size_t bytes) {
    unsigned char *out = destination;
    const unsigned char *in = source;
    size_t index;
    for (index = 0; index < bytes; index++) out[index] = in[index];
    return destination;
}

void *memset(void *destination, int value, size_t bytes) {
    unsigned char *out = destination;
    size_t index;
    for (index = 0; index < bytes; index++) out[index] = (unsigned char)value;
    return destination;
}

void *memmove(void *destination, const void *source, size_t bytes) {
    unsigned char *out = destination;
    const unsigned char *in = source;
    size_t index;
    if (out < in) for (index = 0; index < bytes; index++) out[index] = in[index];
    else for (index = bytes; index != 0; index--) out[index - 1] = in[index - 1];
    return destination;
}

int memcmp(const void *left, const void *right, size_t bytes) {
    const unsigned char *a = left;
    const unsigned char *b = right;
    size_t index;
    for (index = 0; index < bytes; index++) if (a[index] != b[index]) return (int)a[index] - (int)b[index];
    return 0;
}

int abs(int value) { return value < 0 ? -value : value; }

int fclose(void *stream) { (void)stream; return -1; }

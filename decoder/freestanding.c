#include <stddef.h>
#include <stdint.h>

#define HEAP_LIMIT (2u * 1024u * 1024u)
#define ALIGNMENT 16u
#define BLOCK_MAGIC 0x4d464c43u

typedef struct Block Block;
struct Block {
    size_t size;
    Block *next;
    uint32_t magic;
    uint32_t free;
};

extern unsigned char __heap_base;
static uintptr_t heap_next;
static Block *free_list;
static size_t live_bytes;
static size_t peak_live_bytes;
static uintptr_t peak_heap_end;
static uint32_t free_calls;
static uint32_t realloc_calls;

static size_t aligned(size_t bytes) {
    return (bytes + (ALIGNMENT - 1u)) & ~(size_t)(ALIGNMENT - 1u);
}

static uintptr_t heap_start(void) {
    return aligned((uintptr_t)&__heap_base);
}

static void record_live(size_t bytes) {
    live_bytes += bytes;
    if (live_bytes > peak_live_bytes) peak_live_bytes = live_bytes;
    if (heap_next > peak_heap_end) peak_heap_end = heap_next;
}

static void trim_frontier(void) {
    for (;;) {
        Block **link = &free_list;
        Block *block = free_list;
        while (block != NULL && (uintptr_t)block + sizeof(Block) + block->size != heap_next) {
            link = &block->next;
            block = block->next;
        }
        if (block == NULL) return;
        *link = block->next;
        heap_next = (uintptr_t)block;
    }
}

void *malloc(size_t bytes) {
    Block **link;
    Block *block;
    size_t wanted;
    uintptr_t start;
    if (bytes == 0) bytes = 1;
    if (bytes > HEAP_LIMIT - ALIGNMENT) return NULL;
    wanted = aligned(bytes);
    link = &free_list;
    block = free_list;
    while (block != NULL && block->size < wanted) {
        link = &block->next;
        block = block->next;
    }
    if (block != NULL) {
        *link = block->next;
        if (block->size >= wanted + sizeof(Block) + ALIGNMENT) {
            Block *rest = (Block *)((uintptr_t)block + sizeof(Block) + wanted);
            rest->size = block->size - wanted - sizeof(Block);
            rest->magic = BLOCK_MAGIC;
            rest->free = 1;
            rest->next = *link;
            *link = rest;
            block->size = wanted;
        }
        block->free = 0;
        block->next = NULL;
        record_live(block->size);
        return (void *)(block + 1);
    }
    if (heap_next == 0) heap_next = heap_start();
    start = heap_next;
    if (start > HEAP_LIMIT - sizeof(Block) || wanted > HEAP_LIMIT - start - sizeof(Block)) return NULL;
    block = (Block *)start;
    block->size = wanted;
    block->next = NULL;
    block->magic = BLOCK_MAGIC;
    block->free = 0;
    heap_next = start + sizeof(Block) + wanted;
    record_live(wanted);
    return (void *)(block + 1);
}

void free(void *pointer) {
    Block *block;
    Block **link;
    Block *previous;
    if (pointer == NULL) return;
    block = ((Block *)pointer) - 1;
    if (block->magic != BLOCK_MAGIC || block->free != 0) return;
    free_calls += 1;
    block->free = 1;
    live_bytes -= block->size;
    link = &free_list;
    previous = NULL;
    while (*link != NULL && (uintptr_t)*link < (uintptr_t)block) {
        previous = *link;
        link = &(*link)->next;
    }
    block->next = *link;
    *link = block;
    if (block->next != NULL && (uintptr_t)block + sizeof(Block) + block->size == (uintptr_t)block->next) {
        block->size += sizeof(Block) + block->next->size;
        block->next = block->next->next;
    }
    if (previous != NULL && (uintptr_t)previous + sizeof(Block) + previous->size == (uintptr_t)block) {
        previous->size += sizeof(Block) + block->size;
        previous->next = block->next;
    }
    trim_frontier();
}

void *realloc(void *pointer, size_t bytes) {
    Block *block;
    unsigned char *result;
    size_t copied;
    size_t index;
    if (pointer == NULL) return malloc(bytes);
    realloc_calls += 1;
    if (bytes == 0) { free(pointer); return NULL; }
    block = ((Block *)pointer) - 1;
    if (block->magic != BLOCK_MAGIC || block->free != 0) return NULL;
    if (aligned(bytes) <= block->size) return pointer;
    result = malloc(bytes);
    if (result == NULL) return NULL;
    copied = block->size < bytes ? block->size : bytes;
    for (index = 0; index < copied; index++) result[index] = ((unsigned char *)pointer)[index];
    free(pointer);
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

uint32_t miso_flac_allocator_live_bytes(void) { return (uint32_t)live_bytes; }
uint32_t miso_flac_allocator_peak_live_bytes(void) { return (uint32_t)peak_live_bytes; }
uint32_t miso_flac_allocator_peak_heap_bytes(void) {
    return peak_heap_end == 0 ? 0u : (uint32_t)(peak_heap_end - heap_start());
}
uint32_t miso_flac_allocator_free_calls(void) { return free_calls; }
uint32_t miso_flac_allocator_realloc_calls(void) { return realloc_calls; }

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

/**
 * Outbreak rail-graph crossing kernel. Same math as
 * src/outbreakNetwork.mjs railCrossHitsCpu: each pair is eight doubles
 * (x1,y1,x2,y2,x3,y3,x4,y4); a hit is an interior crossing (u,w in (0,1)).
 *
 * Binary protocol on stdin/stdout (little-endian):
 *   in:  "GEVRC1\0\0" (8), uint32 n, float64 xy[8n]
 *   out: uint32 n, uint8 hit[n], pad to 8, float64 u[n], float64 w[n]
 *
 * Optional. The Node worker falls back to CPU when this binary is missing.
 */
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include <cuda_runtime.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static const char kMagic[8] = {'G', 'E', 'V', 'R', 'C', '1', '\0', '\0'};

#define CUDA_CHECK(expr)                                                      \
  do {                                                                        \
    cudaError_t err = (expr);                                                 \
    if (err != cudaSuccess) {                                                 \
      std::fprintf(stderr, "cuda: %s\n", cudaGetErrorString(err));            \
      return 1;                                                               \
    }                                                                         \
  } while (0)

__global__ void rail_cross_kernel(const double* xy, int n, unsigned char* hit,
                                  double* u, double* w) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  const double* p = xy + static_cast<size_t>(i) * 8;
  const double x1 = p[0], y1 = p[1], x2 = p[2], y2 = p[3];
  const double x3 = p[4], y3 = p[5], x4 = p[6], y4 = p[7];
  const double den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (fabs(den) < 1e-15) {
    hit[i] = 0;
    return;
  }
  const double uu = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const double ww = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
  if (uu <= 0.0 || uu >= 1.0 || ww <= 0.0 || ww >= 1.0) {
    hit[i] = 0;
    return;
  }
  hit[i] = 1;
  u[i] = uu;
  w[i] = ww;
}

static bool read_all(void* dst, size_t n) {
  auto* p = static_cast<unsigned char*>(dst);
  size_t got = 0;
  while (got < n) {
    size_t r = std::fread(p + got, 1, n - got, stdin);
    if (r == 0) return false;
    got += r;
  }
  return true;
}

static bool write_all(const void* src, size_t n) {
  auto* p = static_cast<const unsigned char*>(src);
  size_t put = 0;
  while (put < n) {
    size_t w = std::fwrite(p + put, 1, n - put, stdout);
    if (w == 0) return false;
    put += w;
  }
  return true;
}

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  char magic[8];
  if (!read_all(magic, 8) || std::memcmp(magic, kMagic, 8) != 0) {
    std::fprintf(stderr, "cuda: bad magic\n");
    return 1;
  }
  uint32_t n = 0;
  if (!read_all(&n, 4)) {
    std::fprintf(stderr, "cuda: missing count\n");
    return 1;
  }
  if (n == 0) {
    if (!write_all(&n, 4)) return 1;
    return 0;
  }
  const size_t xy_bytes = static_cast<size_t>(n) * 8 * sizeof(double);
  std::vector<double> xy(static_cast<size_t>(n) * 8);
  if (!read_all(xy.data(), xy_bytes)) {
    std::fprintf(stderr, "cuda: short pairs\n");
    return 1;
  }

  double* d_xy = nullptr;
  unsigned char* d_hit = nullptr;
  double* d_u = nullptr;
  double* d_w = nullptr;
  CUDA_CHECK(cudaMalloc(&d_xy, xy_bytes));
  CUDA_CHECK(cudaMalloc(&d_hit, n));
  CUDA_CHECK(cudaMalloc(&d_u, static_cast<size_t>(n) * sizeof(double)));
  CUDA_CHECK(cudaMalloc(&d_w, static_cast<size_t>(n) * sizeof(double)));
  CUDA_CHECK(cudaMemcpy(d_xy, xy.data(), xy_bytes, cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemset(d_hit, 0, n));

  const int block = 256;
  const int grid = static_cast<int>((n + block - 1) / block);
  rail_cross_kernel<<<grid, block>>>(d_xy, static_cast<int>(n), d_hit, d_u, d_w);
  CUDA_CHECK(cudaGetLastError());
  CUDA_CHECK(cudaDeviceSynchronize());

  std::vector<unsigned char> hit(n);
  std::vector<double> u(n);
  std::vector<double> w(n);
  CUDA_CHECK(cudaMemcpy(hit.data(), d_hit, n, cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(u.data(), d_u, static_cast<size_t>(n) * sizeof(double),
                        cudaMemcpyDeviceToHost));
  CUDA_CHECK(cudaMemcpy(w.data(), d_w, static_cast<size_t>(n) * sizeof(double),
                        cudaMemcpyDeviceToHost));
  cudaFree(d_xy);
  cudaFree(d_hit);
  cudaFree(d_u);
  cudaFree(d_w);

  const uint32_t pad = (8 - (n % 8)) % 8;
  unsigned char zeros[8] = {0};
  if (!write_all(&n, 4)) return 1;
  if (!write_all(hit.data(), n)) return 1;
  if (pad && !write_all(zeros, pad)) return 1;
  if (!write_all(u.data(), static_cast<size_t>(n) * sizeof(double))) return 1;
  if (!write_all(w.data(), static_cast<size_t>(n) * sizeof(double))) return 1;
  return 0;
}

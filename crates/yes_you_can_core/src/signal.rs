//! Automotive Signal Processing & Anomaly Engine.
//!
//! Provides descriptive statistics, a spectrum estimate and a correlation:
//! - Skewness (Fisher-Pearson coefficient of asymmetry)
//! - Kurtosis (Fisher's definition with excess kurtosis)
//! - Radix-2 Cooley-Tukey FFT with Hann Windowing and SNR estimation
//! - Cross-signal Pearson correlation coefficient
//!
//! ## What this module is not
//!
//! - **Not zero-allocation.** `compute_statistics` clones the input to sort it
//!   (`values.to_vec()`), `compute_fft` allocates its two work buffers
//!   (`vec![0.0; n]` twice). `cross_correlation` is the only allocation-free
//!   entry point. The module header used to claim "zero-allocation, vectorized";
//!   that was a claim without a measurement (AGENTS 0.E E25, finding 2), and it
//!   is corrected here rather than defended.
//! - **Not vectorized.** Every loop is scalar. No SIMD intrinsics are used.
//! - **Not tested.** There is no `#[cfg(test)]` block in this file — see
//!   `crates/yes_you_can_core/README.md`. A statistic nobody checks is a
//!   statistic nobody should quote.

use std::f64::consts::PI;

#[derive(Debug, Clone, PartialEq)]
pub struct SignalStatistics {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub median: f64,
    pub variance: f64,
    pub std_dev: f64,
    pub skewness: f64,
    pub kurtosis: f64,
    pub p5: f64,
    pub p50: f64,
    pub p95: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrequencySpectrum {
    pub dominant_frequency: f64,
    pub dominant_magnitude: f64,
    pub snr_db: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Anomaly {
    pub timestamp_ms: f64,
    pub value: f64,
    pub reason: &'static str,
    pub z_score: f64,
}

/// Compute higher-order descriptive statistics.
pub fn compute_statistics(values: &[f64]) -> Option<SignalStatistics> {
    if values.is_empty() {
        return None;
    }

    let n = values.len() as f64;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut sum = 0.0;

    for &v in values {
        if v < min { min = v; }
        if v > max { max = v; }
        sum += v;
    }

    let mean = sum / n;

    let mut m2 = 0.0;
    let mut m3 = 0.0;
    let mut m4 = 0.0;

    for &v in values {
        let diff = v - mean;
        let diff2 = diff * diff;
        m2 += diff2;
        m3 += diff2 * diff;
        m4 += diff2 * diff2;
    }

    let variance = if values.len() > 1 { m2 / (n - 1.0) } else { 0.0 };
    let std_dev = variance.sqrt();

    let (skewness, kurtosis) = if std_dev > 1e-12 && values.len() >= 3 {
        let skew = (m3 / n) / (std_dev * std_dev * std_dev);
        let kurt = ((m4 / n) / (variance * variance)) - 3.0; // excess kurtosis
        (skew, kurt)
    } else {
        (0.0, 0.0)
    };

    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let percentile = |p: f64| -> f64 {
        let idx = (p * (sorted.len() - 1) as f64).round() as usize;
        sorted[idx]
    };

    Some(SignalStatistics {
        min,
        max,
        mean,
        median: percentile(0.50),
        variance,
        std_dev,
        skewness,
        kurtosis,
        p5: percentile(0.05),
        p50: percentile(0.50),
        p95: percentile(0.95),
    })
}

/// Fast Fourier Transform (FFT) with Hann window and peak detection.
pub fn compute_fft(timestamps: &[f64], values: &[f64]) -> FrequencySpectrum {
    if values.len() < 4 {
        return FrequencySpectrum {
            dominant_frequency: 0.0,
            dominant_magnitude: 0.0,
            snr_db: 0.0,
        };
    }

    // Next power of 2
    let n = values.len().next_power_of_two();
    let mut real = vec![0.0; n];
    let mut imag = vec![0.0; n];

    // Hann window application to avoid spectral leakage
    let num_samples = values.len();
    for i in 0..num_samples {
        let hann = 0.5 * (1.0 - (2.0 * PI * i as f64 / (num_samples as f64 - 1.0)).cos());
        real[i] = values[i] * hann;
    }

    cooley_tukey_fft(&mut real, &mut imag);

    let total_duration_s = (timestamps.last().unwrap_or(&1.0) - timestamps.first().unwrap_or(&0.0)) / 1000.0;
    let sample_rate = if total_duration_s > 0.0 {
        (num_samples - 1) as f64 / total_duration_s
    } else {
        10.0
    };

    let half = n / 2;
    let mut max_mag = 0.0;
    let mut dominant_bin = 1;
    let mut total_power = 0.0;

    for i in 1..half {
        let mag = (real[i] * real[i] + imag[i] * imag[i]).sqrt() / (num_samples as f64);
        total_power += mag * mag;
        if mag > max_mag {
            max_mag = mag;
            dominant_bin = i;
        }
    }

    let dominant_freq = dominant_bin as f64 * sample_rate / n as f64;
    let noise_power = (total_power - max_mag * max_mag).max(1e-12);
    let snr_db = 10.0 * (max_mag * max_mag / noise_power).log10();

    FrequencySpectrum {
        dominant_frequency: (dominant_freq * 100.0).round() / 100.0,
        dominant_magnitude: (max_mag * 1000.0).round() / 1000.0,
        snr_db: (snr_db * 10.0).round() / 10.0,
    }
}

/// In-place Cooley-Tukey Radix-2 Decimation-in-Time FFT.
fn cooley_tukey_fft(real: &mut [f64], imag: &mut [f64]) {
    let n = real.len();
    if n <= 1 {
        return;
    }

    // Bit reversal permutation
    let mut j = 0;
    for i in 0..n {
        if i < j {
            real.swap(i, j);
            imag.swap(i, j);
        }
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
    }

    // Butterfly computations
    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let angle = -2.0 * PI / len as f64;
        let w_real = angle.cos();
        let w_imag = angle.sin();

        let mut i = 0;
        while i < n {
            let mut u_real = 1.0;
            let mut u_imag = 0.0;

            for k in 0..half {
                let u = i + k;
                let v = i + k + half;

                let t_real = u_real * real[v] - u_imag * imag[v];
                let t_imag = u_real * imag[v] + u_imag * real[v];

                real[v] = real[u] - t_real;
                imag[v] = imag[u] - t_imag;
                real[u] += t_real;
                imag[u] += t_imag;

                let next_u_real = u_real * w_real - u_imag * w_imag;
                let next_u_imag = u_real * w_imag + u_imag * w_real;
                u_real = next_u_real;
                u_imag = next_u_imag;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Cross-correlation (Pearson coefficient) between two synchronous signals.
pub fn cross_correlation(a: &[f64], b: &[f64]) -> f64 {
    let len = a.len().min(b.len());
    if len < 2 {
        return 0.0;
    }

    let a_slice = &a[..len];
    let b_slice = &b[..len];

    let mean_a = a_slice.iter().sum::<f64>() / len as f64;
    let mean_b = b_slice.iter().sum::<f64>() / len as f64;

    let mut cov = 0.0;
    let mut var_a = 0.0;
    let mut var_b = 0.0;

    for i in 0..len {
        let da = a_slice[i] - mean_a;
        let db = b_slice[i] - mean_b;
        cov += da * db;
        var_a += da * da;
        var_b += db * db;
    }

    let denom = (var_a * var_b).sqrt();
    if denom > 1e-12 {
        cov / denom
    } else {
        0.0
    }
}

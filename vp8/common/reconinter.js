'use strict';
var MotionVector = require('../common/mv.js');

var filter = require('../common/filter.js');
var filter_block2d = filter.filter_block2d;

var SPLITMV = 9;
var MB_MODE_COUNT = 10;

var idctllm = require('../common/idctllm.js');
var vp8_short_inv_walsh4x4_c = idctllm.vp8_short_inv_walsh4x4_c;
var vp8_short_idct4x4llm_c = idctllm.vp8_short_idct4x4llm_c;

function memset(ptr, ptr_off, value, num) {

    var i = num;
    while (i--)
        ptr[ptr_off + i] = value;
    
}

function memcpy(dst, dst_off, src, src_off, num) {
    
    var i = num;
    while (i--) {
        dst[dst_off + i] = src[src_off + i];
    }
    return dst;
    
}

function memset_32(ptr, ptr_off, value, num){
    
    var i = num ;//>> 2;
    var ptr_off_32 = ptr_off >> 2;
    var ptr_32 = ptr.data_32;
    var value_32 = value | value << 8  | value << 16 | value << 24;

     var num_32 = num >> 2;
     for(var i = 0; i < num_32; i++){
         ptr_32[ptr_off_32 + (i >> 2)] = value_32;
     }
     
}

//Keep from having to redeclare this
var chroma_mv = [
        new MotionVector(),
        new MotionVector(),
        new MotionVector(),
        new MotionVector()
    ];
    
    
    //build_inter_predictors4b
function predict_inter_emulated_edge(ctx,
        img, coeffs, coeffs_off, mbi, mb_col, mb_row) {


    var emul_block = ctx.frame_strg[0].img.img_data;
    var emul_block_off = ctx.frame_strg[0].img.img_data_off;
    
    var reference = 0;
    var reference_off = 0;
    var output = 0;
    var output_off = 0;
    var reference_offset = 0;
    var w = 0, h = 0, x = 0, y = 0, b = 0;

    

    var ref_frame = mbi.mbmi.ref_frame;
    
    var u = img.u, v = img.v;
    var u_off = img.u_off;
    var v_off = img.v_off;
    var full_pixel = (ctx.common.version === 3) + 0;

    x = mb_col << 4;
    y = mb_row << 4;
    w = ctx.mb_cols << 4;
    h = ctx.mb_rows << 4;

    output = img.y;
    output_off = img.y_off;
    reference_offset = ctx.ref_frame_offsets[ref_frame];
    reference = ctx.ref_frame_offsets_[ref_frame];
    reference_off = output_off + reference_offset;
    var mode = mbi.mbmi.y_mode;
    var mvs = mbi.bmi.mvs;

    reference_offset = ctx.ref_frame_offsets[ref_frame];
    reference = ctx.ref_frame_offsets_[ref_frame];

    // Luma 
    for (b = 0; b < 16; b++) {
        
        var ymv;

        if (mode !== SPLITMV)
            ymv = mbi.mbmi.mv;
        else
            ymv = mvs[ b];

        recon_1_edge_block(output, output_off, emul_block, emul_block_off, reference, reference_off, img.stride,
                ymv, ctx.subpixel_filters,
                coeffs, coeffs_off, mbi, x, y, w, h, b);

        x += 4;
        output_off += 4;
        reference_off += 4;

        if ((b & 3) === 3) {
            x -= 16;
            y += 4;
            output_off += (img.stride << 2) - 16;
            reference_off += (img.stride << 2)  - 16;
        }
        
    }

    x = mb_col << 4;
    y = mb_row << 4;

    // Chroma 
    x >>= 1;
    y >>= 1;
    w >>= 1;
    h >>= 1;

    //if (mbi.mbmi.y_mode !== SPLITMV)
    //{
    var uv_stride_4_8 = 4 * img.uv_stride - 8;
    
    for (b = 0; b < 4; b++) {

        recon_1_edge_block(u, u_off, emul_block, emul_block_off, reference, u_off + reference_offset, //u
                img.uv_stride,
                chroma_mv[b], ctx.subpixel_filters,
                coeffs, coeffs_off, mbi, x, y, w, h, b + 16);


        recon_1_edge_block(v, v_off, emul_block, emul_block_off, reference, v_off + reference_offset, //v
                img.uv_stride,
                chroma_mv[b], ctx.subpixel_filters,
                coeffs, coeffs_off, mbi, x, y, w, h, b + 20);


        u_off += 4;
        v_off += 4;
        x += 4;

        if ((b & 1) === 1) {
            x -= 8;
            y += 4;
            u_off += uv_stride_4_8;
            v_off += uv_stride_4_8;
        }

    }
    //}

}



function build_4x4uvmvs(mbi, full_pixel) {
    var mvs = mbi.bmi.mvs;
    for (var i = 0; i < 2; ++i) {
        for (var j = 0; j < 2; ++j) {

            var b = (i << 3) + (j  << 1);
            var chroma_ptr = (i << 1) + j;

            var temp = 0;

            

            temp = mvs[b].x +
                    mvs[b + 1].x +
                    mvs[b + 4].x +
                    mvs[b + 5].x;

            if (temp < 0)
                temp -= 4;
            else
                temp += 4;

            chroma_mv[chroma_ptr].x = (temp / 8 ) | 0;

            temp = mvs[b].y +
                    mvs[b + 1].y +
                    mvs[b + 4].y +
                    mvs[b + 5].y;

            if (temp < 0)
                temp -= 4;
            else
                temp += 4;

            chroma_mv[chroma_ptr].y = (temp / 8) | 0;

            if (full_pixel === 1) {
                chroma_mv[chroma_ptr].as_int &= 0xFFF8FFF8;

            }


        }
    }
}




function build_mc_border(dst, dst_off, src, src_off, stride, x, y, b_w, b_h, w, h) {
    var ref_row = 0;
    var ref_row_off = 0;


    /* Get a pointer to the start of the real data for this row */
    ref_row = src;
    ref_row_off = src_off - x - y * stride;

    if (y >= h)
        ref_row_off += (h - 1) * stride;
    else if (y > 0)
        ref_row_off += y * stride;

    do {
        var left = 0, right = 0, copy = 0;


        if (x < 0) {
            left = -x;
        } else {
            left = 0;
        }

        if (left > b_w)
            left = b_w;

        if (x + b_w > w)
            right = x + b_w - w;

        if (right > b_w)
            right = b_w;

        copy = b_w - left - right;
        
        if (left)
            memset(dst, dst_off, ref_row[ref_row_off], left);

        if (copy)
            memcpy(dst, dst_off + left, ref_row, ref_row_off + x + left, copy);

        if (right)
            memset(dst, dst_off + left + copy, ref_row[ref_row_off + w - 1], right);

        dst_off += stride;
        y++;

        if (y < h && y > 0)
            ref_row_off += stride;
    } while (--b_h);
}

var uvmv = new MotionVector();

function predict_inter(ctx, img, coeffs, coeffs_off, mbi) {
    var y, u , v;
    var y = u = v =  img.y;
    var y_off = img.y_off;
    var u_off = img.u_off;
    var v_off = img.v_off;
    var reference;
    var reference_offset = 0;

    var full_pixel = (ctx.common.version === 3) + 0;
    var b = 0;

    var mbmi_cache = mbi.mbmi;
    var mode = mbmi_cache.y_mode;
    

    reference_offset = ctx.ref_frame_offsets[mbi.mbmi.ref_frame];
    reference = ctx.ref_frame_offsets_[mbi.mbmi.ref_frame];
    var stride = img.stride;
    var subpixel_filters = ctx.subpixel_filters;

    
    for (b = 0; b < 16; b++) {
        var ymv;

        if (mode !== SPLITMV)
            ymv = mbmi_cache.mv;
        else
            ymv = mbi.bmi.mvs[ +b];


        recon_1_block(y, y_off, reference, y_off + reference_offset, stride, //y
                ymv, subpixel_filters, coeffs, coeffs_off, mbi, b);
        y_off += 4;

        if ((b & 3) === 3)
            y_off += (img.stride << 2) - 16;
    }

    var uv_stride = img.uv_stride;
    
    for (b = 0; b < 4; b++) {

        
        recon_1_block(u, u_off, reference, u_off + reference_offset, //u
                uv_stride, chroma_mv[b],
                subpixel_filters, coeffs, coeffs_off, mbi, b + 16);

        recon_1_block(v, v_off, reference, v_off + reference_offset, //v
                uv_stride, chroma_mv[b],
                subpixel_filters, coeffs, coeffs_off, mbi, b + 20);

        u_off += 4;
        v_off += 4;

        if ((b & 1) === 1)
        {
            u_off += (uv_stride << 2) - 8;
            v_off += (uv_stride << 2) - 8;
        }

    }
    
    

}


//build_inter_predictors2b
function recon_1_block(output, output_off, reference, reference_off, stride, mv, filters, coeffs, coeffs_off, mbi, b) {
    var predict = reference;
    var predict_off = reference_off;
    var mx = 0, my = 0;
    
    if (mv.as_int) {
        
        mx = mv.x & 7;
        my = mv.y & 7;
        
        reference_off += ((mv.y >> 3) * stride) + (mv.x >> 3);        
        
        if (mx | my) {
       
            filter_block2d(output, output_off, stride, reference, reference_off, stride, 4, 4, mx, my,
                filters);    
        
            predict = output;
            predict_off = output_off;
        } else {
            predict_off = reference_off;
            //vp8_copy_mem8x4
        }
        
    }
     
    vp8_short_idct4x4llm_c(output, output_off, predict, predict_off, stride, coeffs, coeffs_off + 16 * b);

}

function recon_1_edge_block(output, output_off,
        emul_block, emul_block_off, reference, reference_off, stride, mv_, filters, coeffs,
        coeffs_off, mbi, x, y, w, h, start_b) {
            
    var predict = reference;
    var predict_off = reference_off;
    var b = start_b;
    var b_w = 4;
    var b_h = 4;
    var mx = 0, my = 0;

    x += mv_.x >> 3;
    y += mv_.y >> 3;



    if (x < 2 || x + b_w - 1 + 3 >= w || y < 2 || y + b_h - 1 + 3 >= h) {
        
        reference_off += (mv_.x >> 3) + (mv_.y >> 3) * stride;
        build_mc_border(emul_block, emul_block_off,
                reference, reference_off - 2 - (stride << 1), stride,
                x - 2, y - 2, b_w + 5, b_h + 5, w, h);
        reference = emul_block;
        reference_off = emul_block_off + (stride << 1) + 2;
        reference_off -= (mv_.x >> 3) + (mv_.y >> 3) * stride;
        
    }
 
 
    

    if (mv_.as_int) {

        mx = mv_.x & 7;
        my = mv_.y & 7;


        reference_off += ((mv_.y >> 3) * stride) + (mv_.x >> 3);
    
        
        if (mx | my) {

            filter_block2d(output, output_off, stride, reference, reference_off, stride, 4, 4, mx, my,
filters);
            
            predict = output;
            predict_off = output_off;
        } else {
            
            predict = reference;
            predict_off = reference_off;
            
        }
        
    }
    
    
    vp8_short_idct4x4llm_c(output, output_off, predict, predict_off, stride, coeffs, coeffs_off + 16 * b);
    
}

function build_inter4x4_predictors_mb(){
    
}

function vp8_build_inter16x16_predictors_mb(mbi, full_pixel) {

    var mbmi_cache = mbi.mbmi;

    uvmv.as_int = mbmi_cache.mv.as_int;

    if (mbi.mbmi.need_mc_border) {
        var x = uvmv.x;
        var y = uvmv.y;
        uvmv.x = (x + 1 + ((x >> 31) << 1));
        uvmv.y = (y + 1 + ((y >> 31) << 1));
        uvmv.x /= 2;
        uvmv.y /= 2;

    } else {
        uvmv.x = (uvmv.x + 1) >> 1;
        uvmv.y = (uvmv.y + 1) >> 1;
    }

    if (full_pixel) {
        uvmv.as_int &= 0xFFF8FFF8;
    }

    chroma_mv[0].as_int =
            chroma_mv[1].as_int =
            chroma_mv[2].as_int =
            chroma_mv[3].as_int = uvmv.as_int;

}

//xd->subpixel_predict8x8 = vp8_sixtap_predict8x8;
function vp8_build_inter_predictors_mb(ctx,
        img, coeffs, coeffs_off, mbi, mb_col, mb_row) {

    var y, u, v;
    var y = u = v = img.y;
    var y_off = img.y_off;
    var u_off = img.u_off;
    var v_off = img.v_off;
    var reference;
    var reference_offset = 0;

    var full_pixel = (ctx.common.version === 3) + 0;
    var b = 0;

    var mbmi_cache = mbi.mbmi;
    
    if (mbmi_cache.y_mode !== SPLITMV) {

        vp8_short_inv_walsh4x4_c(coeffs, coeffs_off + 384, coeffs_off);
        vp8_build_inter16x16_predictors_mb(mbi, full_pixel);


    } else {

        build_4x4uvmvs(mbi, full_pixel);
        build_inter4x4_predictors_mb();
    }


    if (mbi.mbmi.need_mc_border)
        predict_inter_emulated_edge(ctx, img, coeffs, coeffs_off, mbi, mb_col, mb_row);

    else
        predict_inter(ctx, img, coeffs, coeffs_off, mbi);

}

module.exports = {};
module.exports.predict_inter_emulated_edge = predict_inter_emulated_edge;
module.exports.predict_inter = predict_inter;
module.exports.vp8_build_inter_predictors_mb = vp8_build_inter_predictors_mb;
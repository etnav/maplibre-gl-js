import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {buildOutlineFrame, buildRoofFrame, convexHull, toLocalUV} from './roof_frame.ts';

describe('convexHull', () => {
    test('drops the reflex corner of an L-shaped ring', () => {
        const ring = [
            new Point(0, 0), new Point(20, 0), new Point(20, 10), new Point(10, 10),
            new Point(10, 20), new Point(0, 20), new Point(0, 0),
        ];

        expect(convexHull(ring).map(({x, y}) => [x, y])).not.toContainEqual([10, 10]);
        expect(convexHull(ring)).toHaveLength(5);
    });
});

describe('buildRoofFrame', () => {
    test('a direction turns the slope axis to face that bearing', () => {
        const footprint = [[new Point(0, 0), new Point(40, 0), new Point(40, 20), new Point(0, 20), new Point(0, 0)]];

        const east = buildRoofFrame(footprint, 90);

        expect(east.axisY[0]).toBeCloseTo(1, 9);
        expect(east.axisY[1]).toBeCloseTo(0, 9);
        expect(east.halfWidth).toBeCloseTo(20, 9);
        expect(east.halfLength).toBeCloseTo(10, 9);
    });

    test('without a direction the ridge follows the long side of a rotated footprint', () => {
        const angle = Math.PI / 6;
        function corner(u: number, v: number): Point {
            return new Point(u * Math.cos(angle) - v * Math.sin(angle), u * Math.sin(angle) + v * Math.cos(angle));
        }
        const footprint = [[corner(0, 0), corner(40, 0), corner(40, 10), corner(0, 10), corner(0, 0)]];

        const frame = buildRoofFrame(footprint, undefined);

        expect(Math.abs(frame.axisX[0] * Math.cos(angle) + frame.axisX[1] * Math.sin(angle))).toBeCloseTo(1, 9);
        expect(frame.halfLength).toBeCloseTo(20, 9);
        expect(frame.halfWidth).toBeCloseTo(5, 9);
        expect(toLocalUV(frame, corner(20, 5).x, corner(20, 5).y).map((value) => Math.abs(value))).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9)]);
    });

    test('an empty footprint gets a zero-sized frame at the origin', () => {
        expect(buildRoofFrame([], undefined)).toEqual({
            center: [0, 0], axisX: [1, 0], axisY: [expect.closeTo(0, 9), 1], halfLength: 0, halfWidth: 0,
        });

        const facingEast = buildRoofFrame([[]], 90);
        expect(facingEast.center).toEqual([0, 0]);
        expect(facingEast.halfLength).toBe(0);
        expect(facingEast.halfWidth).toBe(0);
        expect(facingEast.axisY[0]).toBeCloseTo(1, 9);
    });
});

describe('buildOutlineFrame', () => {
    test('a shifted outline, in any vertex order, gets the frame of the outline at the origin, shifted', () => {
        const atOrigin = buildRoofFrame([[new Point(0, 0), new Point(20, 0), new Point(20, 20), new Point(0, 20), new Point(0, 0)]], undefined);

        const shuffled = [new Point(4020, 3020), new Point(4000, 3000), new Point(4000, 3020), new Point(4020, 3000)];
        const frame = buildOutlineFrame(shuffled, undefined);

        expect(frame).toEqual({...atOrigin, center: [atOrigin.center[0] + 4000, atOrigin.center[1] + 3000]});
        expect(frame.axisX).toEqual([1, 0]);
    });

    test('direction reaches the frame', () => {
        const outline = [new Point(1000, 500), new Point(1040, 500), new Point(1040, 520), new Point(1000, 520)];

        const facingEast = buildOutlineFrame(outline, 90);
        expect(facingEast.axisY).toEqual([expect.closeTo(1, 9), expect.closeTo(0, 9)]);
        expect(facingEast.halfLength).toBeCloseTo(10, 9);
        expect(facingEast.halfWidth).toBeCloseTo(20, 9);
        expect(facingEast.center).toEqual([expect.closeTo(1020, 9), expect.closeTo(510, 9)]);
    });
});

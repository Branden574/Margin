import type { Annotation } from '@margin/core';
import { annotationPaths, bounds, dashPattern, pathData, textLike } from './model';

export function AnnotationGraphic({
  annotation: a,
  selected = false,
}: {
  annotation: Annotation;
  selected?: boolean;
}) {
  const b = bounds(a),
    paths = annotationPaths(a);
  let graphic;
  if (textLike(a)) {
    const signature = a.type === 'signature',
      stamp = a.type === 'stamp';
    const size = signature ? (a.fontSize ?? 28) : stamp ? 12 : 16;
    graphic = (
      <g transform={`rotate(${a.rotation ?? 0} ${a.x} ${a.y})`} opacity={a.opacity}>
        {stamp && (
          <rect
            x={a.x}
            y={a.y}
            width={a.width ?? 140}
            height={a.height ?? 36}
            fill="none"
            stroke={a.color}
            strokeWidth={a.strokeWidth}
            rx="3"
          />
        )}
        <text
          x={a.x + (stamp ? 10 : 0)}
          y={a.y + (stamp ? 24 : size)}
          fill={a.color}
          fontSize={size}
          fontFamily={signature ? '"Times New Roman", serif' : 'Arial, sans-serif'}
          fontStyle={signature ? 'italic' : undefined}
          fontWeight={stamp ? '700' : undefined}
        >
          {(a.text ?? '').split('\n').map((line, i) => (
            <tspan key={i} x={a.x + (stamp ? 10 : 0)} dy={i ? size + 5 : 0}>
              {line || ' '}
            </tspan>
          ))}
        </text>
      </g>
    );
  } else if (a.type === 'comment')
    graphic = (
      <g>
        <rect x={a.x} y={a.y} width="24" height="24" rx="9" fill={a.color} />
        <text
          x={a.x + 12}
          y={a.y + 17}
          textAnchor="middle"
          fill="white"
          fontSize="15"
          fontWeight="600"
        >
          !
        </text>
      </g>
    );
  else if (paths.length)
    graphic = (
      <>
        {paths.map((points, index) => (
          <path
            key={index}
            d={pathData(points) + (points.length === 1 ? ' l 0.1 0' : '')}
            fill="none"
            stroke={a.color}
            strokeWidth={a.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={a.opacity}
            strokeDasharray={
              a.type === 'arrow' && index > 0 ? undefined : dashPattern(a)?.join(' ')
            }
          />
        ))}
      </>
    );
  else if (a.type === 'ellipse')
    graphic = (
      <ellipse
        cx={a.x + (a.width ?? 0) / 2}
        cy={a.y + (a.height ?? 0) / 2}
        rx={(a.width ?? 0) / 2}
        ry={(a.height ?? 0) / 2}
        fill="none"
        stroke={a.color}
        strokeWidth={a.strokeWidth}
        strokeLinecap="round"
        strokeDasharray={dashPattern(a)?.join(' ')}
        opacity={a.opacity}
      />
    );
  else
    graphic = (
      <rect
        x={a.x}
        y={a.y}
        width={a.width}
        height={a.height}
        rx={a.type === 'highlight' ? 2 : 0}
        fill={a.type === 'highlight' ? a.color : 'none'}
        stroke={a.type === 'highlight' ? 'none' : a.color}
        strokeWidth={a.strokeWidth}
        strokeLinecap="round"
        strokeDasharray={dashPattern(a)?.join(' ')}
        opacity={a.opacity}
      />
    );
  return (
    <g data-annotation-id={a.id} data-annotation-type={a.type}>
      {graphic}
      {selected ? (
        <rect
          x={b.x - 5}
          y={b.y - 5}
          width={b.width + 10}
          height={b.height + 10}
          fill="none"
          stroke="#b85d3c"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
      ) : null}
    </g>
  );
}

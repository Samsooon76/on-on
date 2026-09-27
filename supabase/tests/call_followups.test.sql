begin;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000001','followups@test.invalid'),('00000000-0000-4000-8000-000000000002','outsider@test.invalid');
insert into public.organizations(id,name) values ('10000000-0000-4000-8000-000000000001','Followups'),('10000000-0000-4000-8000-000000000002','Other');
insert into public.memberships(organization_id,user_id,role) values ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','member');
insert into public.lines(id,organization_id,phone_number,voice_enabled) values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','+33102030405',true);
insert into public.line_assignments(organization_id,line_id,user_id,can_voice) values ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true);
insert into public.calls(id,organization_id,line_id,remote_number,direction,status) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','+33601020304','outbound','answered');
insert into public.contacts(id,organization_id,display_name) values ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Client'),('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Other client');
do $$ begin
  assert not has_table_privilege('anon','public.call_followups','select'),'No anonymous reads';
  assert not has_table_privilege('authenticated','public.call_followups','delete'),'No direct deletion';
  assert not has_column_privilege('authenticated','public.call_followups','call_id','update'),'Cannot move followups to another call';
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
insert into public.call_followups(id,organization_id,call_id,contact_id,created_by,kind,title) values (
 '50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','ticket','Facture à corriger');
do $$ begin
  assert (select count(*) from public.call_followups)=1,'Assigned member creates and reads during a call';
  begin
    insert into public.call_followups(id,organization_id,call_id,created_by,kind,title) values (gen_random_uuid(),'10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','ticket','Forged author');
    raise exception 'Forged author accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.call_followups(id,organization_id,call_id,contact_id,created_by,kind,title) values (gen_random_uuid(),'10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','ticket','Other tenant contact');
    raise exception 'Other tenant contact accepted';
  exception when insufficient_privilege then null; end;
end $$;
update public.call_followups set status='closed';
do $$ begin assert (select status from public.call_followups limit 1)='closed','Ticket resolution persists'; end $$;
reset role;
update public.calls set status='completed', ended_at=now();
set local role authenticated;
insert into public.call_followups(id,organization_id,call_id,created_by,kind,title,amount) values (
 '50000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','deal','Offre commerciale',1234.56);
do $$ begin assert (select count(*) from public.call_followups)=2,'Can create after hangup'; end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ declare changed integer; begin
  assert (select count(*) from public.call_followups)=0,'Outsider cannot read';
  update public.call_followups set status='open'; get diagnostics changed=row_count;
  assert changed=0,'Outsider cannot update';
end $$;
reset role;
update public.line_assignments set can_voice=false;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
do $$ begin
  assert (select count(*) from public.call_followups)=0,'Revoked line access removes followup access';
  begin
    insert into public.call_followups(id,organization_id,call_id,created_by,kind,title) values (gen_random_uuid(),'10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','ticket','Revoked');
    raise exception 'Revoked assignment accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'Call followups: creation during/after calls, persistence, status changes, tenant isolation, authorship and revoked access verified.' as result;
rollback;
